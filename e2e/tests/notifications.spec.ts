// E2E-8 (W9-D): each entrant gets exactly one outcome notification per game day, and `question_live`
// reaches only non-entrants, through the notify queue and W9-A's channel mocks on the stack.
//
// Five players, every one subscribed to web push (the push mock; the spec decrypts each push as a
// browser would). P1 and P5 also link Farcaster and turn its mini app notifications on through the
// API's webhook; P2 verifies an email. Round 1 (Free and Stakes) is daily-shaped: P1–P3 enter both
// modes, P4 only Free, P5 nothing. Round 2 (Free) opens when round 1 closes, so its `question_live`
// goes to players with no entry in round 1: P5 alone. Round 1's two modes reveal separately (Free
// settles, then the Stakes proposal confirms), and each entrant gets one combined `outcome` for the
// game day on each of their channels, ending "The next question is live." (round 2 is open by then);
// the second mode's result is app-only. Notifications are matched by their dedupe key: the push
// `tag`, or the Farcaster `notificationId` (the key without the user for per-user events). The only
// seam calls are the two rounds' setup.
import { randomInt } from 'node:crypto';
import { gameDayOf, OUTCOME_NEXT_LIVE } from '@flocked/shared';
import { expect, poll, test, type Stack, type User } from '../fixtures';
import {
  emailsTo,
  farcasterSent,
  linkFarcaster,
  pushes,
  subscribePush,
  verifyEmail,
  type PushInbox,
} from '../fixtures/notify';
import { enterFree, enterStakes, publicRound, scheduleRound, waitRound } from '../fixtures/rounds';

/** Round 1's picks: option 0 is the minority in both modes. P5 enters nothing. */
const FREE_PICKS = [0, 1, 1, 1] as const;
const STAKES_PICKS = [0, 1, 1] as const;
const STAKE = 1_000_000n;
/** How long a second outcome would have to land after the last mode revealed. */
const QUIET_MS = 20_000;
/** The outcome emails' subjects (packages/shared/src/copy/notifications.ts). */
const OUTCOME_SUBJECT = /^(Unflocked|You got flocked|.* round refunded|Your pick didn't count)/;

test.describe.configure({ mode: 'serial' });

test.describe('E2E-8: one outcome per entrant per game day; question_live only to non-entrants', () => {
  const players: User[] = [];
  const inbox: PushInbox[] = [];
  const farcaster: Record<number, string> = {};
  let email: string;
  let round1: string;
  let round2: string;
  let closesAt: number;

  /** Player i's push tags (dedupe keys), oldest first. */
  const tags = async (stack: Stack, i: number) =>
    (await pushes(stack, inbox[i]!)).map((p) => p.tag);

  test('setup: players and their channels; two rounds, the second opening at the first close', async ({
    stack,
    clock,
    user,
  }) => {
    await clock.release();
    for (let i = 0; i < 5; i++) players.push(await user({ stakes: i < STAKES_PICKS.length }));
    for (const p of players) inbox.push(await subscribePush(stack, p));
    const fid = randomInt(2_000_000, 9_000_000);
    farcaster[0] = await linkFarcaster(stack, players[0]!, fid);
    farcaster[4] = await linkFarcaster(stack, players[4]!, fid + 1);
    email = `p2-${randomInt(1e9)}@flocked.test`;
    await verifyEmail(stack, players[1]!, email);

    const r1 = await scheduleRound(stack, {
      opensInMs: 20_000,
      openForMs: 75_000,
      beaconDelay: 60,
      stakes: { stake: String(STAKE), minEntrants: 3, capMultiple: 1 },
    });
    round1 = r1.roundId;
    closesAt = r1.closesAt;
    const r2 = await stack.seam<{ roundId: string }>('/rounds/scheduled', {
      opensAt: r1.closesAt,
      closesAt: r1.closesAt + 8 * 60_000,
      beaconDelay: 60,
    });
    expect(r2.status).toBe(201);
    round2 = r2.body.roundId;
  });

  test('round 1 opens and its question_live reaches every player once', async ({
    stack,
    clock,
  }) => {
    const open = await waitRound(
      stack,
      round1,
      'round 1 to open',
      90_000,
      (r) => r.status === 'open',
    );
    for (const [i, p] of players.entries()) {
      if (i < FREE_PICKS.length) await enterFree(stack, p, open, FREE_PICKS[i]!, 25n);
      if (i < STAKES_PICKS.length) await enterStakes(stack, clock, p, open, STAKES_PICKS[i]!);
    }
    expect(Date.now()).toBeLessThan(open.closesAt * 1000);
    // Nobody entered a daily round closing at round 1's open, so everyone reachable heard of it.
    for (const [i, p] of players.entries()) {
      const key = `question_live:${round1}:${p.userId}`;
      await poll(`P${i + 1}'s question_live for round 1`, 60_000, async () =>
        (await tags(stack, i)).includes(key) ? true : null,
      );
      expect((await tags(stack, i)).filter((t) => t === key)).toHaveLength(1);
    }
  });

  test("round 2 opens at round 1's close: question_live reaches P5 alone", async ({ stack }) => {
    await waitRound(stack, round2, 'round 2 to open', 120_000, (r) => r.status === 'open');
    const key = (p: User) => `question_live:${round2}:${p.userId}`;
    await poll("P5's question_live for round 2", 60_000, async () =>
      (await tags(stack, 4)).includes(key(players[4]!)) ? true : null,
    );
    await poll("P5's Farcaster question_live for round 2", 60_000, async () =>
      (await farcasterSent(stack, farcaster[4]!)).some(
        (n) => n.notificationId === `question_live:${round2}`,
      )
        ? true
        : null,
    );
  });

  test('round 1 reveals both modes; each entrant gets exactly one outcome for the game day', async ({
    stack,
    clock,
  }) => {
    await poll('both modes of round 1 to reveal', 300_000, async () => {
      await clock.mine(4);
      const r = await publicRound(stack, round1);
      return r?.modes.free?.status === 'settled' && r.modes.stakes?.status === 'settle_proposed'
        ? r
        : null;
    });
    const gameDay = gameDayOf(Math.floor(closesAt / 1000));
    const entrants = players.slice(0, FREE_PICKS.length);
    for (const [i, p] of entrants.entries()) {
      await poll(`P${i + 1}'s outcome push`, 60_000, async () =>
        (await tags(stack, i)).includes(`outcome:${gameDay}:${p.userId}`) ? true : null,
      );
    }
    // Long enough for a second mode's outcome to arrive, were it sent.
    await new Promise((r) => setTimeout(r, QUIET_MS));

    for (const [i, p] of entrants.entries()) {
      const shown = (await pushes(stack, inbox[i]!)).filter((s) => s.tag.startsWith('outcome:'));
      expect(
        shown.map((s) => s.tag),
        `P${i + 1}`,
      ).toEqual([`outcome:${gameDay}:${p.userId}`]);
      expect(shown[0]!.body.endsWith(OUTCOME_NEXT_LIVE), shown[0]!.body).toBe(true);
      expect(shown[0]!.url).toContain(`/r/${round1}`);
    }
    const p1Outcomes = (await farcasterSent(stack, farcaster[0]!)).filter((n) =>
      n.notificationId.startsWith('outcome:'),
    );
    expect(p1Outcomes.map((n) => n.notificationId)).toEqual([`outcome:${gameDay}`]);
    const p2Outcomes = (await emailsTo(stack, email)).filter((e) =>
      OUTCOME_SUBJECT.test(e.subject),
    );
    expect(p2Outcomes, JSON.stringify(p2Outcomes.map((e) => e.subject))).toHaveLength(1);

    // P5 entered nothing: no outcome on any channel.
    expect((await tags(stack, 4)).filter((t) => t.startsWith('outcome:'))).toEqual([]);
    expect(
      (await farcasterSent(stack, farcaster[4]!)).filter((n) =>
        n.notificationId.startsWith('outcome:'),
      ),
    ).toEqual([]);
  });

  test("round 2's question_live never reached round 1's entrants", async ({ stack }) => {
    for (const [i, p] of players.slice(0, FREE_PICKS.length).entries()) {
      expect(await tags(stack, i), `P${i + 1}`).not.toContain(
        `question_live:${round2}:${p.userId}`,
      );
    }
    expect((await farcasterSent(stack, farcaster[0]!)).map((n) => n.notificationId)).not.toContain(
      `question_live:${round2}`,
    );
    expect(
      (await tags(stack, 4)).filter((t) => t === `question_live:${round2}:${players[4]!.userId}`),
    ).toHaveLength(1);
  });
});
