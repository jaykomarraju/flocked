// A full Free round in the browser on the stack (W9-D.2; spec "Testing and acceptance criteria" E2E-1
// Free UI and E2E-2 UI, "Client app" › Entry flow (Free)): three players sign in through the sign-in
// dialog with a test wallet, each picks and seals in its own browser (tlock in the page, the receipt
// checked and stored), and the round closes, gets its beacon and reveals on its own: the cron driver
// locks it, the RoundDO's alarms close and reveal it, and nothing is called after the seam schedules
// it. Each browser shows Sealed, the unsealing countdown, "Counting the flock…" and the reveal, with
// the minority side winning and its own result as `GET /rounds/:id/me` has it; axe on Today, Sealed
// and each Reveal phase.
//
// The tests run in order and share the round and the three pages. Each page records the Reveal phases
// it draws (`[data-phase]`, with the text it drew them with), and the spec checks the record.
// "Counting the flock…" lasts from the page's first 1 s tick past beacon time to the `revealed` event,
// which on the stack lands within about a second of beacon time (61 ms after the tick in one run), so
// a page could go from unsealing straight to the reveal. Each page's round socket therefore goes
// through a proxy (`holdRevealed`) that passes the server's messages on in order but holds `revealed`
// for 2 s: counting is always drawn, and every message is still the server's own.
import { randomInt } from 'node:crypto';
import { VOICE, lossLine, winLine, type RoundView } from '@flocked/shared';
import { commitment, fromBase64Url } from '@flocked/tlock';
import type { Page } from '@playwright/test';
import { expect, poll, test } from '../fixtures';
import {
  installWallet,
  newPlayerPage,
  pageRoundMe,
  preparePage,
  signInWithWallet,
} from '../fixtures/browser';
import { scheduleRound, waitRound, type Scheduled } from '../fixtures/rounds';
import { expectAccessible } from './world';

test.describe.configure({ mode: 'serial' });

/** "Your pick is sealed…" (VOICE.sealed), "Counting the flock…" (features/reveal/copy.ts). */
const SEALED = VOICE.sealed;
const COUNTING = 'Counting the flock…';

interface Player {
  name: string;
  page: Page;
  userId: string;
  /** Option 0 is the smaller side: one pick against two. */
  pick: 0 | 1;
  /** The stake preset clicked; null keeps the default (25). */
  preset: string | null;
  stake: string;
}

const PLAYERS = [
  { name: 'P1', pick: 0, preset: null, stake: '25' },
  { name: 'P2', pick: 1, preset: '10', stake: '10' },
  { name: 'P3', pick: 1, preset: null, stake: '25' },
] as const;

/** The Reveal phases a page drew, in order, each with the text it was first drawn with. */
interface PhaseSeen {
  phase: string;
  at: number;
  text: string;
}

/** Records every `[data-phase]` the page draws (RevealView), from the first document on. */
async function recordPhases(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const g = globalThis as unknown as {
      __flockedPhases?: PhaseSeen[];
      document: {
        querySelector(
          s: string,
        ): { getAttribute(n: string): string | null; textContent: string | null } | null;
      };
      MutationObserver: new (cb: () => void) => { observe(n: unknown, o: unknown): void };
    };
    const seen: PhaseSeen[] = [];
    g.__flockedPhases = seen;
    let last: string | null = null;
    const note = () => {
      const el = g.document.querySelector('[data-phase]');
      const phase = el?.getAttribute('data-phase') ?? null;
      if (phase === last) return;
      last = phase;
      const main = g.document.querySelector('main');
      seen.push({
        phase: phase ?? 'none',
        at: Date.now(),
        text: (el ?? main)?.textContent?.slice(0, 300) ?? '',
      });
    };
    new g.MutationObserver(note).observe(g.document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-phase'],
    });
  });
}

/**
 * The Reveal phases drawn, in order, from the first one (Today and Sealed draw none). A gap after it
 * (`none`) would be a blink: the screen staying mounted at the close is part of what this checks.
 */
async function phasesSeen(page: Page): Promise<PhaseSeen[]> {
  const seen = await page.evaluate(
    () => (globalThis as unknown as { __flockedPhases?: PhaseSeen[] }).__flockedPhases ?? [],
  );
  const first = seen.findIndex((s) => s.phase !== 'none');
  return first < 0 ? [] : seen.slice(first);
}

function messageType(msg: string): unknown {
  try {
    return (JSON.parse(msg) as { type?: unknown }).type;
  } catch {
    return null; // "pong"
  }
}

/** How long the proxy holds a `revealed` message: longer than the page's 1 s clock tick. */
const HOLD_REVEALED_MS = 2000;

/**
 * Proxies the page's round sockets to the stack: every message both ways, in order, with each
 * `revealed` from the server held `HOLD_REVEALED_MS` (and the messages after it queued behind it).
 */
async function holdRevealed(page: Page): Promise<void> {
  await page.routeWebSocket(/\/api\/v1\/rounds\/[^/]+\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let queue = Promise.resolve();
    server.onMessage((msg) => {
      const held = typeof msg === 'string' && messageType(msg) === 'revealed';
      queue = queue
        .then(() => (held ? new Promise<void>((r) => setTimeout(r, HOLD_REVEALED_MS)) : undefined))
        .then(() => ws.send(msg));
    });
  });
}

/** The pick this device stored for the round (apps/web/src/crypto/picks.ts). */
async function storedPick(page: Page, userId: string, roundId: string) {
  const raw = await page.evaluate(
    (key) =>
      (
        globalThis as unknown as { localStorage: { getItem(k: string): string | null } }
      ).localStorage.getItem(key),
    `flocked.pick.${userId}.${roundId}.free`,
  );
  return raw
    ? (JSON.parse(raw) as {
        optionIndex: number;
        stake: string;
        ciphertext: string;
        receipt: Record<string, unknown>;
        mismatches: string[];
      })
    : null;
}

const prompt = `Free round ${randomInt(1e9)}: tea or coffee?`;
let scheduled: Scheduled;
let round: RoundView;
const players: Player[] = [];

test.beforeAll(async ({ browser }, testInfo) => {
  for (const p of PLAYERS) {
    const page = await newPlayerPage(browser, testInfo);
    players.push({ ...p, page, userId: '' });
  }
});

test.afterAll(async () => {
  await Promise.all(players.map((p) => p.page.context().close()));
});

test('E2E-1 Free UI: three players sign in in the browser with a wallet while the round is scheduled', async ({
  stack,
}) => {
  test.setTimeout(3 * 60_000);
  // Opens in 40 s (the cron driver's tick locks it first), open for 2 minutes, beacon 60 s after.
  scheduled = await scheduleRound(stack, {
    opensInMs: 40_000,
    openForMs: 120_000,
    beaconDelay: 60,
    prompt,
  });
  await Promise.all(
    players.map(async (p) => {
      await preparePage(p.page, stack);
      await installWallet(p.page);
      await recordPhases(p.page);
      await holdRevealed(p.page);
      p.userId = await signInWithWallet(p.page);
    }),
  );
  expect(new Set(players.map((p) => p.userId)).size).toBe(3);
});

test('E2E-1 Free UI: each player picks and seals in the browser, and its receipt checks out (axe on Today and Sealed)', async ({
  stack,
}) => {
  test.setTimeout(4 * 60_000);
  round = await waitRound(
    stack,
    scheduled.roundId,
    'the round to lock and open',
    120_000,
    (r) => r.status === 'open' && r.lockedAt !== null,
  );
  await Promise.all(
    players.map(async (p) => {
      const { page } = p;
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: prompt })).toBeVisible();
      const options = page.getByRole('radiogroup', { name: prompt });
      await options.getByRole('radio').nth(p.pick).click();
      if (p.preset) {
        await page
          .getByRole('radiogroup', { name: 'Stake presets' })
          .getByRole('radio', { name: p.preset, exact: true })
          .click();
      }
      await expectAccessible(page);
      await page.getByRole('button', { name: 'Seal my pick' }).click();
      await expect(page.getByText(SEALED)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('timer', { name: 'Reveal in' })).toBeVisible();
      await expectAccessible(page);
    }),
  );

  for (const p of players) {
    // The app checked the receipt (no mismatch) and stored the pick with it; the server holds the
    // same entry, whose commitment is keccak256 of the ciphertext the browser sealed.
    const stored = await storedPick(p.page, p.userId, round.id);
    expect(stored, `${p.name}'s stored pick`).not.toBeNull();
    expect(stored!.mismatches).toEqual([]);
    expect(stored!.optionIndex).toBe(p.pick);
    expect(stored!.stake).toBe(p.stake);
    const ct = fromBase64Url(stored!.ciphertext);
    expect(ct).not.toBeNull();
    const mine = await pageRoundMe(p.page, round.id);
    const free = mine.modes.free!;
    expect(free.entry.stake).toBe(p.stake);
    expect(free.entry.commitment).toBe(commitment(ct!));
    expect(free.entry.optionIndex).toBeNull();
    expect(free.receipt).toMatchObject({
      commitment: free.entry.commitment,
      stake: p.stake,
      signature: stored!.receipt.signature,
    });
  }
});

test('E2E-2 UI: the round closes on its own, and each browser counts down to the unsealing (axe)', async () => {
  test.setTimeout(4 * 60_000);
  await Promise.all(
    players.map(async ({ page }) => {
      const timer = page.getByRole('timer', { name: 'Unsealing in' });
      await expect(timer).toBeVisible({ timeout: 180_000 });
      await expect(timer).toHaveText(/\d:\d\d$/);
      await expect(page.getByText('Your pick')).toBeVisible();
      await expectAccessible(page);
    }),
  );
});

test('E2E-2 UI: the beacon arrives; each browser counts the flock, then reveals the smaller side winning (axe)', async () => {
  test.setTimeout(4 * 60_000);
  await Promise.all(
    players.map(async ({ page }) => {
      const reveal = page.locator('[data-phase="revealed"]');
      await expect(reveal).toBeVisible({ timeout: 180_000 });
      await expect(reveal).toHaveAttribute('data-reveal-stage', 'done', { timeout: 10_000 });
      // One pick on option 0 against two on option 1: option 0 wins with 33%.
      const bars = reveal.getByRole('list', { name: 'How the crowd split' }).getByRole('listitem');
      await expect(bars.nth(0)).toContainText('33%');
      await expect(bars.nth(1)).toContainText('67%');
      await expect(bars.nth(0).locator('[data-winner="true"]')).toHaveCount(1);
      await expect(bars.nth(1).locator('[data-winner="true"]')).toHaveCount(0);
      await expectAccessible(page);
    }),
  );
  for (const p of players) {
    const seen = await phasesSeen(p.page);
    expect(
      seen.map((s) => s.phase),
      `${p.name}'s Reveal phases`,
    ).toEqual(['unsealing', 'counting', 'revealed']);
    expect(seen[0]!.text).toContain('Unsealing in');
    expect(seen[1]!.text).toContain(COUNTING);
  }
});

test('E2E-2 UI: each browser shows its own result, as GET /rounds/:id/me has it', async () => {
  test.setTimeout(2 * 60_000);
  for (const p of players) {
    const mine = await poll(`${p.name}'s result`, 60_000, async () => {
      const me = await pageRoundMe(p.page, round.id);
      return me.modes.free?.result ? me : null;
    });
    const free = mine.modes.free!;
    const won = p.pick === 0;
    expect(free.result).toBe(won ? 'win' : 'loss');
    expect(free.entry.optionIndex).toBe(p.pick);
    expect(free.entry.valid).toBe(true);
    const paid = free.payouts.reduce((a, x) => a + BigInt(x.amount), 0n);
    const stake = BigInt(p.stake);
    const card = p.page.locator('section[data-result]');
    await expect(card).toHaveAttribute('data-result', won ? 'unflocked' : 'got-flocked');
    await expect(card).toContainText(won ? winLine(1, 3) : lossLine(2, 3));
    await expect(card.getByRole('definition').nth(0)).toHaveText(`${p.stake} points`);
    await expect(card.getByRole('definition').nth(1)).toHaveText(
      won
        ? `+${(paid - stake).toLocaleString('en-US')} points`
        : `−${(stake - paid).toLocaleString('en-US')} points`,
      { timeout: 15_000 },
    );
  }
});
