// W7-F1 R6 (decision A3): the Stakes `revealed` reaches the RoundDO only after the indexer's D1
// commit. The `OutcomeProposed` handler runs through the real dispatcher, with a RoundDO stand-in
// that reads D1 when it is called, and a D1 batch that fails once.
import { env } from 'cloudflare:test';
import { flockedEscrowAbi } from '@flocked/abi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModeResult } from '../../src/do/types.js';
import type { Env } from '../../src/env.js';
import { dispatchPending } from '../../src/indexer/dispatch.js';
import { registerStakesHandlers } from '../../src/indexer/handlers/stakes.js';
import { HandlerRegistry } from '../../src/indexer/registry.js';
import type { ChainEvent, IndexerRpc, IndexerTarget } from '../../src/indexer/types.js';
import { BEACON_TIME_MS } from './helpers.js';
import { FAKE_ESCROW, eventsOf } from './stakes-chain.js';
import {
  seedStakes,
  setGameClock,
  stakesEnv,
  stakesHarness,
  stakesMode,
  type SeededStakes,
} from './stakes-helpers.js';

beforeEach(() => {
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const TARGETS: IndexerTarget[] = [
  { kind: 'escrow', address: FAKE_ESCROW, abi: flockedEscrowAbi, startBlock: 0 },
];
const registry = registerStakesHandlers(new HandlerRegistry());

/** One dispatch pass over the mirrored events, with `e` as the handlers' env. */
const dispatch = (e: Env) =>
  dispatchPending(e, registry, {
    chainId: 31337,
    targets: TARGETS,
    rpc: {} as IndexerRpc,
    nowMs: Date.now(),
  });

/** The indexer's mirror of `evt` (src/indexer/core.ts), not yet dispatched. */
async function mirror(evt: ChainEvent): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash,
       log_index, event, args_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0)`,
  )
    .bind(
      evt.chainId,
      evt.contract,
      evt.blockNumber,
      evt.blockHash,
      evt.blockTimestampSec,
      evt.txHash,
      evt.logIndex,
      evt.event,
      JSON.stringify(evt.args),
    )
    .run();
}

interface Heard {
  roundId: string;
  mode: string;
  result: ModeResult;
  /** The Stakes mode row as D1 had it when the RoundDO was called. */
  d1: { status: string; revealed_at: number | null } | null;
}

/** A RoundDO namespace whose objects record each onModeResult call and what D1 said then. */
function roundsHeard(heard: Heard[]): Env['ROUND'] {
  const ns = {
    idFromName: (name: string) => name,
    get: (roundId: string) => ({
      onModeResult: async (mode: string, result: ModeResult) => {
        const d1 = await env.DB.prepare(
          "SELECT status, revealed_at FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'",
        )
          .bind(roundId)
          .first<{ status: string; revealed_at: number | null }>();
        heard.push({ roundId, mode, result, d1 });
      },
    }),
  };
  return ns as unknown as Env['ROUND'];
}

/** Past close and the beacon: the coordinator posts the proposal (mined at once). */
async function proposed(r: SeededStakes): Promise<ChainEvent> {
  r.chain.advanceTo(r.closesAt / 1000 + 4);
  setGameClock(BEACON_TIME_MS + 5_000);
  const h = await stakesHarness(r);
  await h.start();
  expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
  await h.deliver();
  expect(await h.alarm()).toMatchObject({ phase: 'proposing', error: null });
  const [evt] = eventsOf(r.chain, r.chain.lastTx('propose'));
  if (!evt) throw new Error('no OutcomeProposed');
  return evt;
}

describe('W7-F1 R6: the Stakes `revealed` goes to the RoundDO after the D1 commit', () => {
  it('a D1 batch that fails leaves the RoundDO unaware; the retry tells it once revealed_at and settle_proposed are in D1', async () => {
    const r = await seedStakes([0, 1, 1]);
    const evt = await proposed(r);
    await mirror(evt);
    const heard: Heard[] = [];
    const e = { ...env, ROUND: roundsHeard(heard) } as Env;

    const batch = vi
      .spyOn(env.DB, 'batch')
      .mockRejectedValueOnce(new Error('D1_ERROR: unavailable'));
    const first = await dispatch(e);
    expect(first.failed).toMatchObject({
      handler: 'stakes-proposal',
      eventName: 'OutcomeProposed',
    });
    expect(heard).toEqual([]);
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'revealing', revealed_at: null });

    batch.mockRestore();
    expect(await dispatch(e)).toMatchObject({ failed: null, dispatched: 1 });
    const revealedAt = evt.blockTimestampSec * 1000;
    expect(heard.map((x) => [x.roundId, x.mode])).toEqual([[r.roundId, 'stakes']]);
    expect(heard[0]?.result).toMatchObject({ outcome: 'revealed', winningOption: 0, revealedAt });
    expect(heard[0]?.d1).toEqual({ status: 'settle_proposed', revealed_at: revealedAt });
  });
});
