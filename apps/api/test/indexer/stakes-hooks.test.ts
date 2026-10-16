// Stakes post-final hooks through the real dispatcher (W8-D): `RoundFinalized` (Settled) and
// `RoundRefunded` (any reason but 4) run `runModeFinal` once per final mode, from a second handler
// that sees what the outcome handler committed (round_modes.status and the payouts). A hook failure
// fails the entry; the retry runs the hooks again but not the outcome handler, which is marked
// handled. A void, a finalized refund proposal's `RoundFinalized`, and a final event the outcome
// handler refuses run nothing. D1 is seeded directly (the round, its Stakes mode and current
// settlement record, three entries); the logs go through FakeChain, indexOnce and dispatchPending
// with the default registry.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { indexOnce } from '../../src/indexer/core.js';
import { dispatchPending, type DispatchResult } from '../../src/indexer/dispatch.js';
import { handlers } from '../../src/indexer/handlers.js';
import { onModeFinal, type ModeFinalEvent } from '../../src/settlement/hooks.js';
import { escrowEvent, FakeChain, hash32, useDeployment } from './helpers.js';

const SETTLED = 4;
const REFUNDED = 5;
const STAKE = 1_000_000;

let seed = 700;
let chainRoundSeq = 0;
let chain: FakeChain;
let dep: ReturnType<typeof useDeployment>;
let lines: string[];
let unregister: (() => void)[];

const dispatch = (o: { limit?: number } = {}): Promise<DispatchResult> =>
  dispatchPending(env, handlers, {
    chainId: dep.chainId,
    targets: dep.targets,
    rpc: chain,
    nowMs: Date.now(),
    ...o,
  });
const cycle = async (o: { limit?: number } = {}) => {
  await indexOnce({
    db: env.DB,
    rpc: chain,
    chainId: dep.chainId,
    targets: dep.targets,
    nowMs: Date.now(),
  });
  return dispatch(o);
};

/** Structured log lines named `event`. */
const logged = (event: string) =>
  lines.filter((l) => {
    try {
      return (JSON.parse(l) as { event?: string }).event === event;
    } catch {
      return false;
    }
  });

interface HookCall {
  event: ModeFinalEvent;
  /** What D1 showed the hook: the mode's status and its payouts' kinds. */
  status: string | null;
  payouts: string[];
}

/** Registers a post-final hook that records each call and D1 at that moment; the first `failures` calls throw. */
function spyHook(failures = 0): HookCall[] {
  const calls: HookCall[] = [];
  unregister.push(
    onModeFinal(async (e: Env, event: ModeFinalEvent) => {
      const mode = await e.DB.prepare(
        'SELECT status FROM round_modes WHERE round_id = ?1 AND mode = ?2',
      )
        .bind(event.roundId, event.mode)
        .first<{ status: string }>();
      const { results } = await e.DB.prepare(
        'SELECT kind FROM payouts WHERE round_id = ?1 AND mode = ?2 ORDER BY kind',
      )
        .bind(event.roundId, event.mode)
        .all<{ kind: string }>();
      calls.push({ event, status: mode?.status ?? null, payouts: results.map((r) => r.kind) });
      if (calls.length <= failures) throw new Error('hook down');
    }),
  );
  return calls;
}

interface Seeded {
  roundId: string;
  chainRoundId: bigint;
}

/**
 * A closed, locked daily round whose Stakes mode is at `status`, with three entries (one on option
 * 0, the winner, two on option 1) and, unless `record` is null, a current settlement record: a
 * settlement (winner 0, a rebate for the others) or a refund proposal (reason 2).
 */
async function seedStakes(
  status: 'pending' | 'revealing' | 'settle_proposed' | 'refund_proposed',
  record: 'settled' | 'refunded' | null,
): Promise<Seeded> {
  const roundId = newUlid();
  const chainRoundId = BigInt(7000 + chainRoundSeq++);
  const closesAt = 1_799_000_000_000 + chainRoundSeq * 86_400_000;
  const proposed = status === 'settle_proposed' || status === 'refund_proposed';
  const bundleHash = hash32(`bundle:${roundId}`);
  const db = env.DB;
  const picks = [0, 1, 1];
  await db.batch([
    db
      .prepare(
        `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json)
         VALUES (?1, 'daily', NULL, ?2, ?3, ?4, 1, 'closed', 1, '{}')`,
      )
      .bind(roundId, newUlid(), closesAt - 86_400_000, closesAt),
    db
      .prepare(
        `INSERT INTO round_modes (round_id, mode, status, refund_reason, chain_round_id, bundle_hash,
           revealed_at, claims_open_at)
         VALUES (?1, 'stakes', ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        roundId,
        status,
        status === 'refund_proposed' ? 2 : null,
        chainRoundId.toString(),
        proposed ? bundleHash : null,
        proposed ? closesAt + 60_000 : null,
        proposed ? closesAt + 7_200_000 : null,
      ),
    ...(record === null
      ? []
      : [
          db
            .prepare(
              `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json,
                 winners_json, payout_root, bundle_hash)
               VALUES (?1, 'stakes', 0, ?2, 1, ?3, ?4, ?5, ?6)`,
            )
            .bind(
              roundId,
              record,
              JSON.stringify([
                { headcount: 1, total: String(STAKE) },
                { headcount: 2, total: String(2 * STAKE) },
              ]),
              JSON.stringify(
                record === 'settled'
                  ? { winner: 0, refundReason: null, winPayout: '2850000', rebatePayout: '10000' }
                  : { winner: null, refundReason: 2, winPayout: '0', rebatePayout: '0' },
              ),
              record === 'settled' ? hash32(`root:${roundId}`) : null,
              bundleHash,
            ),
        ]),
    ...picks.map((pick, i) =>
      db
        .prepare(
          `INSERT INTO entries (id, round_id, mode, user_id, foreign_entry, wallet, person_tag, stake,
             commitment, tx_hash, block_number, log_index, option_index, valid, created_at)
           VALUES (?1, ?2, 'stakes', ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, 1)`,
        )
        .bind(
          newUlid(),
          roundId,
          newUlid(),
          `0x${(i + 1).toString(16).padStart(40, '0')}`,
          hash32(`person:${roundId}:${i}`),
          STAKE,
          hash32(`ct:${roundId}:${i}`),
          hash32(`entered:${roundId}:${i}`),
          i + 1,
          proposed ? pick : null,
          proposed ? 1 : null,
        ),
    ),
  ]);
  return { roundId, chainRoundId };
}

/** Mines one transaction with these escrow events (log indexes 0, 1, ...); returns its hash. */
function mineTx(...events: [string, Record<string, unknown>][]): Hex {
  const txHash = chain.newTxHash();
  chain.mine(events.map(([name, args]) => ({ ...escrowEvent(dep.escrow, name, args), txHash })));
  return txHash;
}

const finalized = (r: Seeded, status: number) =>
  mineTx(['RoundFinalized', { roundId: r.chainRoundId, status }]);
const refunded = (r: Seeded, reason: number) =>
  mineTx(['RoundRefunded', { roundId: r.chainRoundId, reason }]);

async function modeStatus(roundId: string) {
  return (
    await env.DB.prepare("SELECT status FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'")
      .bind(roundId)
      .first<{ status: string }>()
  )?.status;
}

async function payoutKinds(roundId: string) {
  const { results } = await env.DB.prepare(
    "SELECT kind FROM payouts WHERE round_id = ?1 AND mode = 'stakes' ORDER BY kind",
  )
    .bind(roundId)
    .all<{ kind: string }>();
  return results.map((r) => r.kind);
}

/** The handlers marked handled for the transaction's log `logIndex`. */
async function handledBy(txHash: Hex, logIndex = 0) {
  const { results } = await env.DB.prepare(
    `SELECT handler FROM chain_event_handled
     WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 ORDER BY handler`,
  )
    .bind(dep.chainId, txHash, logIndex)
    .all<{ handler: string }>();
  return results.map((r) => r.handler);
}

async function entryState(txHash: Hex) {
  return env.DB.prepare(
    `SELECT dispatched_revision, dispatch_attempts, dispatch_error FROM chain_events
     WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = 0`,
  )
    .bind(dep.chainId, txHash)
    .first<{
      dispatched_revision: number | null;
      dispatch_attempts: number;
      dispatch_error: string | null;
    }>();
}

const SETTLED_PAYOUTS = ['rebate', 'rebate', 'win'];
const REFUND_PAYOUTS = ['refund', 'refund', 'refund'];

beforeEach(() => {
  chain = new FakeChain();
  dep = useDeployment(seed++);
  lines = [];
  unregister = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  }
});
afterEach(() => {
  for (const off of unregister) off();
  vi.restoreAllMocks();
});

describe('a settled Stakes mode', () => {
  it('RoundFinalized runs the hooks once, after the settlement and its payouts commit', async () => {
    const r = await seedStakes('settle_proposed', 'settled');
    const calls = spyHook();
    const tx = finalized(r, SETTLED);
    expect(await cycle()).toMatchObject({ dispatched: 1, failed: null });
    expect(calls).toEqual([
      {
        event: { roundId: r.roundId, mode: 'stakes', kind: 'daily', outcome: 'settled' },
        status: 'settled',
        payouts: SETTLED_PAYOUTS,
      },
    ]);
    expect(await handledBy(tx)).toEqual([
      'alert-unsent-tx',
      'stakes-finalized',
      'stakes-finalized-hooks',
    ]);
  });

  it('fires once per final mode: a replay and a re-index of the same logs call nothing again', async () => {
    const r = await seedStakes('settle_proposed', 'settled');
    const calls = spyHook();
    finalized(r, SETTLED);
    await cycle();
    expect(calls).toHaveLength(1);

    expect(await dispatch()).toMatchObject({ dispatched: 0, failed: null });
    // Forget the position (as after a crash) and index and dispatch the same range again.
    await env.DB.prepare('DELETE FROM indexer_state WHERE chain_id = ?1').bind(dep.chainId).run();
    expect(await cycle()).toMatchObject({ dispatched: 0, failed: null });
    expect(calls).toHaveLength(1);
  });

  it('a failing hook fails the entry; the retry runs the hooks again, not the outcome handler', async () => {
    const r = await seedStakes('settle_proposed', 'settled');
    const calls = spyHook(1);
    const tx = finalized(r, SETTLED);

    const first = await cycle();
    expect(first).toMatchObject({
      dispatched: 0,
      more: true,
      failed: {
        txHash: tx,
        eventName: 'RoundFinalized',
        handler: 'stakes-finalized-hooks',
        attempts: 1,
      },
    });
    expect(first.failed?.error).toMatch(/mode-final hook\(s\) failed/);
    expect(await entryState(tx)).toMatchObject({
      dispatched_revision: null,
      dispatch_attempts: 1,
      dispatch_error: expect.stringMatching(/^stakes-finalized-hooks: /) as unknown,
    });
    // The outcome handler's commit stands, with its handled mark.
    expect(await handledBy(tx)).toEqual(['alert-unsent-tx', 'stakes-finalized']);
    expect(await modeStatus(r.roundId)).toBe('settled');
    expect(await payoutKinds(r.roundId)).toEqual(SETTLED_PAYOUTS);
    expect(calls).toHaveLength(1);

    expect(await dispatch()).toMatchObject({ dispatched: 1, failed: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(await entryState(tx)).toMatchObject({
      dispatched_revision: 0,
      dispatch_attempts: 0,
      dispatch_error: null,
    });
    expect(await handledBy(tx)).toEqual([
      'alert-unsent-tx',
      'stakes-finalized',
      'stakes-finalized-hooks',
    ]);
    // The outcome handler ran once (it logs `stakes_settled` each time), and nothing doubled.
    expect(logged('stakes_settled')).toHaveLength(1);
    expect(await payoutKinds(r.roundId)).toEqual(SETTLED_PAYOUTS);

    expect(await dispatch()).toMatchObject({ dispatched: 0, failed: null });
    expect(calls).toHaveLength(2);
  });

  it('a RoundFinalized the outcome handler refuses (no current record) runs no hooks', async () => {
    const r = await seedStakes('revealing', null);
    const calls = spyHook();
    finalized(r, SETTLED);
    expect(await cycle()).toMatchObject({ dispatched: 1, failed: null });
    expect(logged('alert').join('\n')).toContain('stakes_finalized_unknown');
    expect(await modeStatus(r.roundId)).toBe('revealing');
    expect(calls).toEqual([]);
  });
});

describe('a refunded or voided Stakes mode', () => {
  it('RoundRefunded (refundTooFew) runs the hooks once with outcome refunded', async () => {
    const r = await seedStakes('pending', null);
    const calls = spyHook();
    const tx = refunded(r, 1);
    expect(await cycle()).toMatchObject({ dispatched: 1, failed: null });
    expect(calls).toEqual([
      {
        event: { roundId: r.roundId, mode: 'stakes', kind: 'daily', outcome: 'refunded' },
        status: 'refunded',
        payouts: REFUND_PAYOUTS,
      },
    ]);
    expect(await handledBy(tx)).toEqual([
      'alert-unsent-tx',
      'stakes-refunded',
      'stakes-refunded-hooks',
      'stakes-void',
    ]);
    expect(await dispatch()).toMatchObject({ dispatched: 0 });
    expect(calls).toHaveLength(1);
  });

  it('a void (RoundRefunded reason 4) runs no hooks', async () => {
    const r = await seedStakes('pending', null);
    const calls = spyHook();
    refunded(r, 4);
    expect(await cycle()).toMatchObject({ dispatched: 1, failed: null });
    expect(await modeStatus(r.roundId)).toBe('voided');
    expect(calls).toEqual([]);

    // Nor for a mode D1 already shows refunded: the reason alone excludes a void, not only the status.
    const done = await seedStakes('pending', null);
    refunded(done, 1);
    await cycle();
    expect(calls).toHaveLength(1);
    refunded(done, 4);
    expect(await cycle()).toMatchObject({ dispatched: 1, failed: null });
    expect(await modeStatus(done.roundId)).toBe('refunded');
    expect(calls).toHaveLength(1);
  });

  it('a finalized refund proposal: RoundFinalized (Refunded) runs nothing; its RoundRefunded does', async () => {
    const r = await seedStakes('refund_proposed', 'refunded');
    const calls = spyHook();
    const tx = mineTx(
      ['RoundFinalized', { roundId: r.chainRoundId, status: REFUNDED }],
      ['RoundRefunded', { roundId: r.chainRoundId, reason: 2 }],
    );
    // One entry per dispatch: RoundFinalized alone first.
    expect(await cycle({ limit: 1 })).toMatchObject({ dispatched: 1, failed: null });
    expect(await handledBy(tx, 0)).toEqual([
      'alert-unsent-tx',
      'stakes-finalized',
      'stakes-finalized-hooks',
    ]);
    expect(await modeStatus(r.roundId)).toBe('refund_proposed');
    expect(calls).toEqual([]);

    expect(await dispatch({ limit: 1 })).toMatchObject({ dispatched: 1, failed: null });
    expect(calls).toEqual([
      {
        event: { roundId: r.roundId, mode: 'stakes', kind: 'daily', outcome: 'refunded' },
        status: 'refunded',
        payouts: REFUND_PAYOUTS,
      },
    ]);
  });
});
