// GET /rounds?before=&limit= (spec "API"; W6-D): closed daily rounds, newest first, `before`
// exclusive by game day, `limit`, the `nextBefore` cursor (null at the end), each mode's revealed
// outcome and refund reason. Room rounds and open rounds are never listed.
import { env } from 'cloudflare:test';
import {
  RoundsArchiveResponseSchema,
  addGameDays,
  dailyClosesAt,
  dailyOpensAt,
  newUlid,
  type RoundArchiveItem,
  type RoundsArchiveResponse,
} from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { OPTIONS, insertRound, request, setClock, type InsertedRound } from './helpers.js';

const D = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'] as const;
const day = (i: number) => D[i] as string;

/** The daily round of game day `d`, as the scheduler places it. */
function daily(d: string, o: Omit<Parameters<typeof insertRound>[0], 'opensAt' | 'closesAt'>) {
  return insertRound({ opensAt: dailyOpensAt(d) * 1000, closesAt: dailyClosesAt(d) * 1000, ...o });
}

async function settlement(
  roundId: string,
  mode: 'free' | 'stakes',
  o: { outcome: 'settled' | 'refunded'; winner: 0 | 1 | null; tally: [number, number][] },
) {
  await env.DB.prepare(
    `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json,
       winners_json, settled_at)
     VALUES (?1, ?2, 0, ?3, 1, ?4, ?5, ?6)`,
  )
    .bind(
      roundId,
      mode,
      o.outcome,
      JSON.stringify(o.tally.map(([headcount, total]) => ({ headcount, total: String(total) }))),
      JSON.stringify({ winner: o.winner, refundReason: o.outcome === 'settled' ? null : 2 }),
      Date.UTC(2026, 2, 1),
    )
    .run();
}

const rounds: InsertedRound[] = [];
let room: InsertedRound;
let open: InsertedRound;

beforeAll(async () => {
  setClock(dailyClosesAt('2026-03-06') * 1000 - 3_600_000);
  const revealedAt = (i: number) => dailyClosesAt(day(i)) * 1000 + 300_000;
  // D1: Free settled, option 1 the minority.
  rounds.push(
    await daily(day(0), { modes: { free: { status: 'settled', revealedAt: revealedAt(0) } } }),
  );
  // D2: Free refunded at settlement (rule 2), Stakes refundTooFew (rule 1).
  rounds.push(
    await daily(day(1), {
      modes: {
        free: { status: 'refunded', refundReason: 2, revealedAt: revealedAt(1) },
        stakes: { status: 'refunded', refundReason: 1, chainRoundId: '3' },
      },
    }),
  );
  // D3: Free settled.
  rounds.push(
    await daily(day(2), { modes: { free: { status: 'settled', revealedAt: revealedAt(2) } } }),
  );
  // D4: voided (rule 4).
  rounds.push(
    await daily(day(3), {
      modes: {
        free: { status: 'voided', refundReason: 4 },
        stakes: { status: 'voided', refundReason: 4, chainRoundId: '4' },
      },
    }),
  );
  // D5: closed, still settling.
  rounds.push(await daily(day(4), { modes: { free: { status: 'pending' } } }));
  // The open round of the next day and a room round closing on D3: never listed.
  open = await daily('2026-03-06', { status: 'open', modes: { free: {} } });
  room = await insertRound({
    kind: 'room',
    opensAt: dailyClosesAt(day(2)) * 1000 - 7_200_000,
    closesAt: dailyClosesAt(day(2)) * 1000 - 3_600_000,
    modes: { free: { status: 'settled', revealedAt: revealedAt(2) } },
  });

  const [r1, r2, r3] = rounds as [InsertedRound, InsertedRound, InsertedRound];
  await settlement(r1.id, 'free', {
    outcome: 'settled',
    winner: 1,
    tally: [
      [1, 25],
      [3, 60],
    ],
  });
  await settlement(r2.id, 'free', {
    outcome: 'refunded',
    winner: null,
    tally: [
      [0, 0],
      [2, 20],
    ],
  });
  await settlement(r3.id, 'free', {
    outcome: 'settled',
    winner: 0,
    tally: [
      [1, 10],
      [2, 20],
    ],
  });
  // D1's entries, for the archive's counts (from D1).
  await env.DB.batch(
    [10, 25].map((stake, seq) =>
      env.DB.prepare(
        `INSERT INTO entries (id, round_id, mode, user_id, stake, commitment, receipt_seq, created_at)
         VALUES (?1, ?2, 'free', ?3, ?4, ?5, ?6, ?7)`,
      ).bind(newUlid(), r1.id, newUlid(), stake, `0x${String(seq).repeat(64)}`, seq, r1.opensAt),
    ),
  );
});

async function archive(query = ''): Promise<{
  ids: string[];
  days: string[];
  body: RoundsArchiveResponse;
}> {
  const res = await request(`/rounds${query}`);
  expect(res.status).toBe(200);
  const body = RoundsArchiveResponseSchema.parse(await res.json());
  return { ids: body.rounds.map((r) => r.id), days: body.rounds.map((r) => r.gameDay), body };
}

const id = (i: number) => (rounds[i] as InsertedRound).id;

describe('GET /rounds', () => {
  it('lists closed daily rounds newest first, never a room round or an open round', async () => {
    const { ids, days, body } = await archive();
    expect(ids).toEqual([id(4), id(3), id(2), id(1), id(0)]);
    expect(days).toEqual([...D].reverse());
    expect(body.nextBefore).toBeNull();
    expect(ids).not.toContain(room.id);
    expect(ids).not.toContain(open.id);
  });

  it('pages with limit and the nextBefore cursor, before exclusive by game day, null at the end', async () => {
    const p1 = await archive('?limit=2');
    expect(p1.ids).toEqual([id(4), id(3)]);
    expect(p1.body.nextBefore).toBe(day(3));
    const p2 = await archive(`?before=${p1.body.nextBefore}&limit=2`);
    expect(p2.ids).toEqual([id(2), id(1)]);
    expect(p2.body.nextBefore).toBe(day(1));
    const p3 = await archive(`?before=${p2.body.nextBefore}&limit=2`);
    expect(p3.ids).toEqual([id(0)]);
    expect(p3.body.nextBefore).toBeNull();
  });

  it('a last page that is exactly full has no cursor', async () => {
    const page = await archive(`?before=${day(2)}&limit=2`);
    expect(page.ids).toEqual([id(1), id(0)]);
    expect(page.body.nextBefore).toBeNull();
    expect((await archive(`?before=${day(0)}`)).body).toEqual({ rounds: [], nextBefore: null });
    // A `before` with no round of its own, and one past every round.
    expect((await archive(`?before=${addGameDays(day(4), 10)}&limit=5`)).ids).toEqual([
      id(4),
      id(3),
      id(2),
      id(1),
      id(0),
    ]);
  });

  it('each mode: status, counts, the revealed winner and tally, and the refund reason', async () => {
    const { body } = await archive();
    const item = (i: number) => body.rounds.find((r) => r.id === id(i)) as RoundArchiveItem;
    expect(item(0)).toEqual({
      id: id(0),
      gameDay: day(0),
      question: {
        id: (rounds[0] as InsertedRound).questionId,
        prompt: `Cats or dogs? (${(rounds[0] as InsertedRound).questionId.slice(-6)})`,
        options: OPTIONS,
        category: 'food',
        author: null,
      },
      modes: {
        free: {
          status: 'settled',
          entrantCount: 2,
          pool: '35',
          winningOption: 1,
          tally: [
            { headcount: 1, total: '25' },
            { headcount: 3, total: '60' },
          ],
          refundReason: null,
        },
      },
    });
    expect(item(1).modes).toEqual({
      free: {
        status: 'refunded',
        entrantCount: 0,
        pool: '0',
        winningOption: null,
        tally: [
          { headcount: 0, total: '0' },
          { headcount: 2, total: '20' },
        ],
        refundReason: 2,
      },
      stakes: {
        status: 'refunded',
        entrantCount: 0,
        pool: '0',
        winningOption: null,
        tally: null,
        refundReason: 1,
      },
    });
    expect(item(3).modes).toMatchObject({
      free: { status: 'voided', refundReason: 4, winningOption: null, tally: null },
      stakes: { status: 'voided', refundReason: 4, winningOption: null, tally: null },
    });
    expect(item(4).modes.free).toMatchObject({
      status: 'pending',
      winningOption: null,
      tally: null,
    });
  });

  it.each([['?before=2026-02-30'], ['?before=yesterday'], ['?limit=0'], ['?limit=101']])(
    '400 for %s',
    async (query) => {
      const res = await request(`/rounds${query}`);
      expect(res.status).toBe(400);
    },
  );
});
