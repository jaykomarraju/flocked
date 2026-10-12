// Shared setup for the lifecycle tests: rounds with a Stakes mode on the fake chain (its escrow knows
// the round, so `voidRound` behaves as FlockedEscrow does), recorders for the settle and notify
// queues, and indexer events built by hand for the lifecycle handlers.
import { env, runInDurableObject } from 'cloudflare:test';
import { newUlid, type SettleMessage } from '@flocked/shared';
import { generatePrivateKey } from 'viem/accounts';
import type { RoundDO } from '../../src/do/round-do.js';
import type { ChainEvent } from '../../src/indexer/types.js';
import { FAKE_ANCHOR, FAKE_DEPLOYMENT, FAKE_ESCROW, FakeChain } from '../anchor-do/fake-chain.js';
import { chain as drand, createRound, type TestRound } from '../round-do/helpers.js';

const original = { QUEUE_SETTLE: env.QUEUE_SETTLE, QUEUE_NOTIFY: env.QUEUE_NOTIFY };

/** Replaces the settle and notify queues with recorders; returns what was settled. */
export function recordQueues(): { settled: SettleMessage[]; restore: () => void } {
  const settled: SettleMessage[] = [];
  Object.assign(env, {
    QUEUE_SETTLE: {
      send: (body: SettleMessage) => {
        settled.push(body);
        return Promise.resolve();
      },
    },
    QUEUE_NOTIFY: { send: () => Promise.resolve(), sendBatch: () => Promise.resolve() },
  });
  return { settled, restore: () => Object.assign(env, original) };
}

let nextChainRoundId = 1n;

/**
 * A locked round with Free and Stakes on a fake chain whose escrow has the round Open until
 * `closesAt`. The RoundDO's `voidRound` goes to the fake chain (receipts are not awaited).
 */
export async function stakesRound(
  fake: FakeChain,
  opts: { modes?: ('free' | 'stakes')[]; opensAt?: number } = {},
): Promise<TestRound & { chainRoundId: string }> {
  const r = await createRound({
    modes: opts.modes ?? ['free', 'stakes'],
    ...(opts.opensAt !== undefined ? { opensAt: opts.opensAt } : {}),
  });
  const chainRoundId = (nextChainRoundId++).toString();
  await env.DB.prepare(
    "UPDATE round_modes SET chain_round_id = ?2 WHERE round_id = ?1 AND mode = 'stakes'",
  )
    .bind(r.locked.roundId, chainRoundId)
    .run();
  if (r.locked.modes.includes('stakes')) {
    r.locked.chainRoundId = chainRoundId;
    fake.escrowRounds.set(BigInt(chainRoundId), {
      closesAt: BigInt(r.locked.closesAt / 1000),
      open: true,
    });
  }
  await useFakeOperator(r.stub, fake);
  return { ...r, chainRoundId };
}

/**
 * One operator key per fake chain: a fresh chain starts every account at nonce 0, while D1's
 * `operator_txs` keeps the file's earlier sends, whose nonces the operator's allocator skips (W6-A).
 */
const operatorKeys = new WeakMap<FakeChain, string>();

/** Points the env's operator at the fake chain and the RoundDO's void at it too. */
export async function useFakeOperator(
  stub: DurableObjectStub<RoundDO>,
  fake: FakeChain,
): Promise<void> {
  if (!operatorKeys.has(fake)) operatorKeys.set(fake, generatePrivateKey());
  Object.assign(env, {
    CHAIN_ID: '31337',
    OPERATOR_KEY: operatorKeys.get(fake),
    LOCAL_DEPLOYMENT: FAKE_DEPLOYMENT,
  });
  await runInDurableObject(stub, (inst: RoundDO) => {
    inst.operatorDeps = { transport: fake.transport, waitMs: 0 };
  });
}

/** A fake chain at the game time `ms`, on the test drand chain. */
export function fakeChainAt(ms: number): FakeChain {
  return new FakeChain({ genesis: drand.genesis, period: drand.period }, Math.floor(ms / 1000));
}

let logIndex = 0;

/** One mirrored log, as the dispatcher hands it to a handler. */
export function chainEvent(
  contract: 'escrow' | 'anchor',
  event: string,
  args: Record<string, unknown>,
  over: Partial<ChainEvent> = {},
): ChainEvent {
  return {
    chainId: 31337,
    contract: contract === 'escrow' ? FAKE_ESCROW : FAKE_ANCHOR,
    contractKind: contract,
    blockNumber: 200,
    blockHash: `0x${'ab'.repeat(32)}`,
    blockTimestampSec: 1_800_000_000,
    txHash: `0x${newUlid().toLowerCase().padStart(64, '0')}`,
    logIndex: logIndex++,
    event,
    args,
    removed: false,
    revision: 1,
    ...over,
  };
}

/** Runs a handler's returned statements, as the dispatcher's batch would. */
export async function commitStatements(stmts: D1PreparedStatement[] | void): Promise<void> {
  if (stmts && stmts.length > 0) await env.DB.batch(stmts);
}

export async function modeRow(roundId: string, mode: 'free' | 'stakes') {
  return env.DB.prepare(
    'SELECT status, refund_reason, final_at, lock_tx, commit_tx, commitment_root FROM round_modes WHERE round_id = ?1 AND mode = ?2',
  )
    .bind(roundId, mode)
    .first<{
      status: string;
      refund_reason: number | null;
      final_at: number | null;
      lock_tx: string | null;
      commit_tx: string | null;
      commitment_root: string | null;
    }>();
}

export async function roundStatus(roundId: string): Promise<string | undefined> {
  const row = await env.DB.prepare('SELECT status FROM rounds WHERE id = ?1')
    .bind(roundId)
    .first<{ status: string }>();
  return row?.status;
}

/** Reads the RoundDO's void record. */
export function voidRecord(stub: DurableObjectStub<RoundDO>) {
  return runInDurableObject(stub, async (_i, state) => {
    const meta = await state.storage.get<{
      void: {
        state: string;
        applied: boolean;
        txHash: string | null;
        detail: string | null;
      } | null;
      done: string[];
    }>('meta');
    return meta?.void ?? null;
  });
}
