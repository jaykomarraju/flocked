// The tick's D1 budget with many rooms (W8-F1 H1). A tick is one invocation, and D1 allows 1,000
// queries per invocation: past that every D1 call throws. Before the fix every tick locked every due
// room round (about 6 statements each) and re-read and re-initialised every live one, so a few
// hundred rooms passed the limit, and the daily round, ordered among them by ID, was starved of its
// RoundDO `init`. This runs the tick with 300 mirror rooms whose round IDs all sort before the daily
// round's, through a D1 wrapper that counts every statement (a batch's included) and throws past the
// limit, as D1 does. The daily round still locks and is initialised, each tick stays under half the
// limit, and the room rounds lock and are initialised over the next minutes.
import { env } from 'cloudflare:test';
import { addGameDays, newUlid } from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import {
  ROOM_LOCKS_PER_TICK,
  ROOM_ROUNDS_PER_TICK,
  schedulerTick,
} from '../../src/scheduler/tick.js';
import { insertRoom, insertRoomRoundRow } from '../rooms/round-helpers.js';
import { HOUR, MIN, chainHarness, insertQuestion, setClock } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

/** D1's queries per invocation (Workers Paid). */
const D1_QUERY_LIMIT = 1000;
/** What one tick may spend: half the limit. */
const TICK_BUDGET = 500;
const ROOMS = 300;

/** env with DB wrapped to count statements (a batch counts each) and to throw past D1's limit. */
function countingEnv(): { env: Env; queries: () => number; reset: () => void } {
  let n = 0;
  const spend = (k: number) => {
    n += k;
    if (n > D1_QUERY_LIMIT) throw new Error('D1_ERROR: too many queries in this invocation');
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...v: unknown[]) => wrap(s.bind(...v)),
      first: (col?: string) => {
        spend(1);
        return col === undefined ? s.first() : s.first(col);
      },
      all: () => {
        spend(1);
        return s.all();
      },
      run: () => {
        spend(1);
        return s.run();
      },
      raw: () => {
        spend(1);
        return s.raw();
      },
    } as unknown as D1PreparedStatement;
    real.set(w, s);
    return w;
  };
  const db = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql)),
    batch: (stmts: D1PreparedStatement[]) => {
      spend(stmts.length);
      return env.DB.batch(stmts.map((w) => real.get(w) ?? w));
    },
  } as unknown as D1Database;
  return {
    // A proxy, not a copy: setClock moves the clock on the shared env.
    env: new Proxy(env, {
      get: (o, k): unknown => (k === 'DB' ? db : Reflect.get(o, k)),
    }),
    queries: () => n,
    reset: () => {
      n = 0;
    },
  };
}

describe('the tick with many rooms (W8-F1 H1)', () => {
  it('locks and initialises the daily round first and stays under half of D1’s limit per tick', async () => {
    const slot = dailySlot(addGameDays('2029-03-01', 0));
    const lockAt = slot.opensAt - 6 * HOUR;
    const roomRounds: string[] = [];
    for (let i = 0; i < ROOMS; i++) {
      const { roomId } = await insertRoom({ source: 'daily' });
      // IDs from the epoch: every room round sorts before the daily round.
      roomRounds.push(await insertRoomRoundRow(roomId, slot, { id: newUlid(i + 1) }));
    }
    const daily = (await insertDailyRound(env.DB, slot)) as string;
    const qId = await insertQuestion({ status: 'scheduled' });
    await env.DB.prepare('UPDATE rounds SET question_id = ?2 WHERE id = ?1').bind(daily, qId).run();
    expect(roomRounds.every((id) => id < daily)).toBe(true);

    const chain = await chainHarness(lockAt);
    const counted = countingEnv();
    const locked = new Set<string>();
    const initialized = new Set<string>();
    const spent: number[] = [];
    // Enough minutes to lock every room round, then to page through all of them once more.
    const ticks = 2 * Math.ceil(ROOMS / Math.min(ROOM_LOCKS_PER_TICK, ROOM_ROUNDS_PER_TICK));
    for (let i = 0; i < ticks; i++) {
      setClock(lockAt + i * MIN);
      counted.reset();
      const report = await schedulerTick(counted.env, chain.deps);
      spent.push(counted.queries());
      if (i === 0) {
        expect(report.locks[daily]).toBe('locked');
        expect(report.initialized).toContain(daily);
        expect(report.lockLeaves).toContain(daily);
      }
      for (const [id, outcome] of Object.entries(report.locks)) {
        if (outcome === 'locked') locked.add(id);
      }
      for (const id of report.initialized) initialized.add(id);
    }

    const state = await env.ROUND.get(env.ROUND.idFromName(daily)).getState();
    expect(state).toMatchObject({ roundId: daily, status: 'scheduled', opensAt: slot.opensAt });
    expect(Math.max(...spent), spent.join(',')).toBeLessThanOrEqual(TICK_BUDGET);
    for (const id of roomRounds) {
      expect(locked.has(id), id).toBe(true);
      expect(initialized.has(id), id).toBe(true);
    }
  }, 120_000);
});
