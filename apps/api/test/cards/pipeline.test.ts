// PIPE-1 (cards half) and AC-7, spec "Share cards and distribution" and "API" › Reveal gating:
//
//   * before a mode's `revealed_at` no card exists — not in R2, not through either image route, not
//     as a share page — even with the settlement's per-option data already written to D1 (the
//     dangerous window test/gating/reveal.test.ts walks for the JSON routes);
//   * after the reveal, every settled player of the round has a card: the fan-out enqueues one per
//     entrant plus the round card, and the consumer gives each a `share_cards` row and three PNGs;
//   * the share page carries the OG and Farcaster mini app embed tags, and its Play link carries the
//     sharer's ref code and the share ID;
//   * an account deletion re-renders the same keys without the handle, and a veto re-renders every
//     card the mode already has.
import { env } from 'cloudflare:test';
import { API_BASE_PATH, type CardsMessage } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { buildCardModel } from '../../src/cards/build.js';
import { cardsHandler } from '../../src/cards/consumer.js';
import { enqueueModeCards, enqueueModeRerender } from '../../src/cards/enqueue.js';
import { cardKey, cardPrefix } from '../../src/cards/keys.js';
import type { Env } from '../../src/env.js';
import { FIXTURE_IDS, seedFixture } from '../helpers/index.js';

const ORIGIN = 'https://api.flocked.test';
const REVEALED_AT = Date.UTC(2026, 9, 9, 1, 5, 0);

let round: string;

/** Queue producer that records instead of sending. */
let sent: CardsMessage[] = [];
const queueEnv = () =>
  ({
    ...env,
    QUEUE_CARDS: {
      send: (body: CardsMessage) => Promise.resolve(void sent.push(body)),
      sendBatch: (ms: { body: CardsMessage }[]) =>
        Promise.resolve(void sent.push(...ms.map((m) => m.body))),
    },
  }) as unknown as Env;

const get = (path: string) => app.request(`${ORIGIN}${API_BASE_PATH}${path}`, {}, env);
const getRoot = (path: string) => app.request(`${ORIGIN}${path}`, {}, env);

/** Three Free entries: two on option 0, one (the fixture user) on the minority option 1. */
const ENTRANTS = [
  { userId: FIXTURE_IDS.user, option: 1, seq: 0, stake: 25, win: 111 },
  { userId: FIXTURE_IDS.otherUser, option: 0, seq: 1, stake: 25, win: 0 },
  { userId: FIXTURE_IDS.admin, option: 0, seq: 2, stake: 25, win: 0 },
];

beforeAll(async () => {
  const fx = await seedFixture(env.DB);
  round = fx.round.id;
  const t = fx.round.closesAt - 3600_000;
  await env.DB.batch([
    ...ENTRANTS.map((e) =>
      env.DB.prepare(
        `INSERT INTO entries (id, round_id, mode, user_id, stake, commitment, receipt_seq,
           option_index, valid, created_at)
         VALUES (?1, ?2, 'free', ?3, ?4, ?5, ?6, ?7, 1, ?8)`,
      ).bind(
        `01K7000000000000000000E${e.seq}`,
        round,
        e.userId,
        e.stake,
        `0x${String(e.seq).repeat(64)}`,
        e.seq,
        e.option,
        t,
      ),
    ),
    // The settlement's per-option data, written before `revealed_at` is set.
    env.DB.prepare(
      `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version,
         tally_json, winners_json, settled_at)
       VALUES (?1, 'free', 0, 'settled', 1, ?2, ?3, ?4)`,
    ).bind(
      round,
      JSON.stringify([
        { headcount: 2, total: '50' },
        { headcount: 1, total: '25' },
      ]),
      JSON.stringify({ winner: 1 }),
      REVEALED_AT,
    ),
    env.DB.prepare(
      `INSERT INTO payouts (round_id, mode, user_id, kind, amount, claimed_at)
       VALUES (?1, 'free', ?2, 'win', 111, ?3)`,
    ).bind(round, FIXTURE_IDS.user, REVEALED_AT),
    env.DB.prepare(
      `INSERT INTO user_stats (user_id, mode, rounds_played, wins, stray_streak,
         best_stray_streak, updated_at)
       VALUES (?1, 'free', 3, 3, 3, 3, ?2)`,
    ).bind(FIXTURE_IDS.user, REVEALED_AT),
    // Settled in every respect but the reveal: `revealing` is the status in that window, and
    // `final_at` goes with the terminal one (round_modes_final_at).
    env.DB.prepare(
      "UPDATE round_modes SET status = 'revealing' WHERE round_id = ?1 AND mode = 'free'",
    ).bind(round),
  ]);
});

async function reveal(): Promise<void> {
  await env.DB.prepare(
    `UPDATE round_modes SET status = 'settled', revealed_at = ?2, final_at = ?2
     WHERE round_id = ?1 AND mode = 'free'`,
  )
    .bind(round, REVEALED_AT)
    .run();
}

async function storedCards(): Promise<string[]> {
  const list = await env.BUCKET.list({ prefix: `cards/${round}/` });
  return list.objects.map((o) => o.key).sort();
}

describe('PIPE-1 (cards half): no card before the mode reveals', () => {
  it('builds no model for a result or round card while revealed_at is null', async () => {
    expect(
      await buildCardModel(env as Env, {
        roundId: round,
        mode: 'free',
        kind: 'result',
        userId: FIXTURE_IDS.user,
      }),
    ).toBeNull();
    expect(
      await buildCardModel(env as Env, { roundId: round, mode: 'free', kind: 'round' }),
    ).toBeNull();
  });

  it('stores nothing, and the round card route is 404', async () => {
    sent = [];
    // The fan-out can run early (a retry, a replay): every message is a no-op until the reveal.
    for (const kind of ['round', 'result'] as const) {
      await cardsHandler(
        {
          roundId: round,
          mode: 'free',
          kind,
          userId: kind === 'result' ? FIXTURE_IDS.user : undefined,
          variants: ['og'],
        },
        env,
      );
    }
    expect(await storedCards()).toEqual([]);
    expect((await get(`/rounds/${round}/card/og.png`)).status).toBe(404);
  });

  it('has no share page and no card image, because no share row exists', async () => {
    const rows = await env.DB.prepare('SELECT count(*) AS n FROM share_cards').first<{
      n: number;
    }>();
    expect(rows?.n).toBe(0);
    expect((await get('/s/Rp4m9Wshare1')).status).toBe(404);
    expect((await get('/cards/Rp4m9Wshare1/og.png')).status).toBe(404);
  });

  it('a teaser exists before the reveal, and shows no per-option data', async () => {
    const teaser = await buildCardModel(env, {
      roundId: round,
      mode: 'free',
      kind: 'teaser',
      userId: FIXTURE_IDS.user,
    });
    expect(teaser).not.toBeNull();
    expect(teaser?.bars).toBe(false);
    expect(teaser?.options.map((o) => o.pct)).toEqual([null, null]);
    expect(teaser?.options.some((o) => o.picked)).toBe(false);
  });
});

describe('AC-7: every settled player has a card', () => {
  it('the fan-out enqueues one card per entrant plus the round card', async () => {
    await reveal();
    sent = [];
    const n = await enqueueModeCards(queueEnv(), round, 'free');
    expect(n).toBe(ENTRANTS.length + 1);
    expect(sent.filter((m) => m.kind === 'round')).toHaveLength(1);
    expect(
      sent
        .filter((m) => m.kind === 'result')
        .map((m) => m.userId)
        .sort(),
    ).toEqual(ENTRANTS.map((e) => e.userId).sort());
    for (const m of sent) expect(m.variants).toHaveLength(3);
  });

  it('the consumer renders every message, with a share row for each player', async () => {
    for (const msg of sent) await cardsHandler(msg, env);
    const keys = await storedCards();
    expect(keys).toHaveLength((ENTRANTS.length + 1) * 3);
    for (const e of ENTRANTS) {
      const prefix = cardPrefix(round, 'free', 'result', e.userId);
      for (const v of ['og', 'embed', 'square'] as const)
        expect(keys).toContain(cardKey(prefix, v));
    }
    const rows = await env.DB.prepare(
      "SELECT user_id, share_id, r2_prefix FROM share_cards WHERE round_id = ?1 AND kind = 'result'",
    )
      .bind(round)
      .all<{ user_id: string; share_id: string; r2_prefix: string }>();
    expect(rows.results).toHaveLength(ENTRANTS.length);
    for (const row of rows.results) {
      expect(row.share_id).toMatch(/^[A-Za-z0-9_-]{8,32}$/);
      expect(row.r2_prefix).toBe(cardPrefix(round, 'free', 'result', row.user_id));
    }
  });

  it("the winner's card says UNFLOCKED with their points and streak", async () => {
    const model = await buildCardModel(env, {
      roundId: round,
      mode: 'free',
      kind: 'result',
      userId: FIXTURE_IDS.user,
    });
    expect(model?.resultLabel).toBe('UNFLOCKED');
    expect(model?.resultValue).toBe('+86 pts');
    expect(model?.resultAccent).toBe(true);
    expect(model?.streak).toBe(3);
    expect(model?.handle).toBe('ewe_one');
    expect(model?.options.map((o) => o.pct)).toEqual(['67%', '33%']);
    expect(model?.options[1]?.winner).toBe(true);
    expect(model?.options[1]?.picked).toBe(true);
  });

  it('a player on the majority side got flocked', async () => {
    const model = await buildCardModel(env, {
      roundId: round,
      mode: 'free',
      kind: 'result',
      userId: FIXTURE_IDS.otherUser,
    });
    expect(model?.resultLabel).toBe('GOT FLOCKED');
    expect(model?.resultValue).toBeNull();
    expect(model?.resultAccent).toBe(false);
    expect(model?.pose).toBe('flock');
  });

  it('serves both image routes as PNG, and renders on demand when a key is missing', async () => {
    const shareId = await env.DB.prepare(
      "SELECT share_id FROM share_cards WHERE round_id = ?1 AND user_id = ?2 AND kind = 'result'",
    )
      .bind(round, FIXTURE_IDS.user)
      .first<{ share_id: string }>();
    const key = cardKey(cardPrefix(round, 'free', 'result', FIXTURE_IDS.user), 'og');
    await env.BUCKET.delete(key);
    const res = await get(`/cards/${shareId?.share_id ?? ''}/og.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(await env.BUCKET.head(key)).not.toBeNull();

    const rootRes = await getRoot(`/cards/${shareId?.share_id ?? ''}/og.png`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('content-type')).toBe('image/png');

    const roundRes = await get(`/rounds/${round}/card/embed.png`);
    expect(roundRes.status).toBe(200);
    expect(roundRes.headers.get('content-type')).toBe('image/png');

    // The round card is not a site URL: at the root it would skip requireRoundAccess, which gates a
    // room round's split under /api/v1.
    expect((await getRoot(`/rounds/${round}/card/embed.png`)).status).toBe(404);
  });
});

describe('the share page', () => {
  it('carries the OG and mini app embed tags, and a Play link with the ref and share ID', async () => {
    const row = await env.DB.prepare(
      "SELECT share_id FROM share_cards WHERE round_id = ?1 AND user_id = ?2 AND kind = 'result'",
    )
      .bind(round, FIXTURE_IDS.user)
      .first<{ share_id: string }>();
    const shareId = row?.share_id ?? '';
    const res = await get(`/s/${shareId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain(
      `property="og:image" content="https://flocked.xyz/cards/${shareId}/og.png"`,
    );
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="fc:miniapp"');
    expect(html).toContain('launch_miniapp');
    expect(html).toContain('name="fc:frame"');
    expect(html).toContain("Play today's Flocked");
    expect(html).toContain(`ref=REFUSER1&amp;share=${shareId}`);
    expect(html).toContain('@ewe_one · Free · Oct 8');
    // Revealed, so the page links to the round.
    expect(html).toContain(`/r/${round}`);

    const rootRes = await getRoot(`/s/${shareId}`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('content-type')).toContain('text/html');
  });

  it('is 404 for an unknown share ID', async () => {
    expect((await get('/s/notashareid')).status).toBe(404);
  });
});

describe('re-renders', () => {
  it('a deletion re-renders the same keys without the handle', async () => {
    const key = cardKey(cardPrefix(round, 'free', 'result', FIXTURE_IDS.user), 'og');
    const before = await env.BUCKET.get(key);
    const beforeBytes = new Uint8Array(await (before as R2ObjectBody).arrayBuffer());
    await env.DB.prepare('UPDATE users SET handle = NULL WHERE id = ?1')
      .bind(FIXTURE_IDS.user)
      .run();
    const model = await buildCardModel(env, {
      roundId: round,
      mode: 'free',
      kind: 'result',
      userId: FIXTURE_IDS.user,
    });
    expect(model?.handle).toBeNull();
    await cardsHandler(
      { roundId: round, mode: 'free', userId: FIXTURE_IDS.user, kind: 'result', variants: ['og'] },
      env,
    );
    const after = await env.BUCKET.get(key);
    const afterBytes = new Uint8Array(await (after as R2ObjectBody).arrayBuffer());
    expect(afterBytes).not.toEqual(beforeBytes);
    // The share ID (and the link to it) survives the re-render.
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM share_cards WHERE round_id = ?1 AND kind = 'result'",
    )
      .bind(round)
      .first<{ n: number }>();
    expect(rows?.n).toBe(ENTRANTS.length);
  });

  it('a veto re-renders every card the mode has, at the same keys', async () => {
    sent = [];
    const n = await enqueueModeRerender(queueEnv(), round, 'free');
    expect(n).toBe(ENTRANTS.length + 1);
    expect(sent.filter((m) => m.kind === 'round')).toHaveLength(1);
    expect(sent.filter((m) => m.kind === 'result')).toHaveLength(ENTRANTS.length);
  });
});
