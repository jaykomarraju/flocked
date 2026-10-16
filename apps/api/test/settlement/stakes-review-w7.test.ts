// W7-F1 review fixes to the Stakes indexer handlers and apply hook, against the fake Base node
// (stakes-chain.ts):
//   - R13: a veto re-mined in another block within one poll, then removed for good, puts the vetoed
//     record back (by its number in the veto's audit row) as a first removal would. The veto goes
//     through the real dispatcher, its chain_events row moved as src/indexer/core.ts moves it;
//   - R15: round_modes.bundle_hash is the chain's: only the `OutcomeProposed` handler writes it;
//   - R16: `OutcomeProposed.payoutRoot` must be the record's root, or the proposal is not confirmed.
import { env } from 'cloudflare:test';
import { flockedEscrowAbi } from '@flocked/abi';
import { bytesToHex, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchPending } from '../../src/indexer/dispatch.js';
import { registerStakesHandlers } from '../../src/indexer/handlers/stakes.js';
import { HandlerRegistry } from '../../src/indexer/registry.js';
import type { ChainEvent, IndexerRpc, IndexerTarget } from '../../src/indexer/types.js';
import { captureAlerts } from '../indexer/helpers.js';
import { BEACON_TIME_MS } from './helpers.js';
import { FAKE_ESCROW, STATUS, chainEventOf, eventsOf } from './stakes-chain.js';
import {
  index,
  seedStakes,
  setGameClock,
  stakesEnv,
  stakesHarness,
  stakesMode,
  stakesPayouts,
  stakesRecords,
  type SeededStakes,
  type StakesHarness,
} from './stakes-helpers.js';

const randomHash = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

beforeEach(() => {
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Past close with the safe head past the close block, after the beacon: start → proposing. */
async function toProposing(r: SeededStakes): Promise<StakesHarness> {
  r.chain.advanceTo(r.closesAt / 1000 + 4);
  setGameClock(BEACON_TIME_MS + 5_000);
  const h = await stakesHarness(r);
  await h.start();
  expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
  await h.deliver();
  expect(await h.alarm()).toMatchObject({ phase: 'proposing', error: null });
  return h;
}

/** The guardian's veto, as the indexer sees it (a vetoed settlement is refunded in the same tx). */
function vetoEvents(r: SeededStakes, refunded: boolean): ChainEvent[] {
  r.chain.veto(r.chainRoundId);
  const at = { txHash: randomHash(), block: r.chain.head };
  const roundId = r.chainRoundId;
  return [
    chainEventOf(r.chain, 'ProposalVetoed', { roundId, evidenceHash: randomHash() }, at),
    ...(refunded
      ? [chainEventOf(r.chain, 'RoundRefunded', { roundId, reason: 5 }, { ...at, logIndex: 1 })]
      : []),
  ];
}

/** `finalize` landing: RoundFinalized (and RoundRefunded for a refund proposal). */
function finalizeEvents(r: SeededStakes, refundReason: number | null): ChainEvent[] {
  r.chain.head += 1;
  const at = { txHash: randomHash(), block: r.chain.head };
  const roundId = r.chainRoundId;
  if (refundReason === null) {
    return [chainEventOf(r.chain, 'RoundFinalized', { roundId, status: STATUS.Settled }, at)];
  }
  return [
    chainEventOf(r.chain, 'RoundFinalized', { roundId, status: STATUS.Refunded }, at),
    chainEventOf(
      r.chain,
      'RoundRefunded',
      { roundId, reason: refundReason },
      { ...at, logIndex: 1 },
    ),
  ];
}

const kinds = async (roundId: string) => (await stakesPayouts(roundId)).map((p) => p.kind).sort();

// The dispatcher over the Stakes handlers (ALERT-8's would need the indexer's RPC).
const TARGETS: IndexerTarget[] = [
  { kind: 'escrow', address: FAKE_ESCROW, abi: flockedEscrowAbi, startBlock: 0 },
];
const registry = registerStakesHandlers(new HandlerRegistry());

/** One dispatch pass; every pending change goes through. */
async function dispatch(): Promise<void> {
  const r = await dispatchPending(env, registry, {
    chainId: 31337,
    targets: TARGETS,
    rpc: {} as IndexerRpc,
    nowMs: Date.now(),
  });
  expect(r).toMatchObject({ failed: null, more: false });
}

/** core.ts mirrors new logs: chain_events rows at revision 0, not yet dispatched. */
async function mirror(evts: ChainEvent[]): Promise<void> {
  await env.DB.batch(
    evts.map((e) =>
      env.DB.prepare(
        `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp,
           tx_hash, log_index, event, args_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0)`,
      ).bind(
        e.chainId,
        e.contract,
        e.blockNumber,
        e.blockHash,
        e.blockTimestampSec,
        e.txHash,
        e.logIndex,
        e.event,
        JSON.stringify(e.args),
      ),
    ),
  );
}

/**
 * One poll finds the same logs in block `block` instead (core.ts's upsert of a changed live row):
 * revision + 2, and the trigger queues the removal of the old block's content (revision + 1).
 */
async function remine(r: SeededStakes, evts: ChainEvent[], block: number): Promise<ChainEvent[]> {
  const moved = evts.map((e) => ({
    ...e,
    blockNumber: block,
    blockHash: r.chain.hashOf(block),
    blockTimestampSec: r.chain.timeOf(block),
    revision: e.revision + 2,
  }));
  await env.DB.batch(
    moved.map((e) =>
      env.DB.prepare(
        `UPDATE chain_events SET block_number = ?4, block_hash = ?5, block_timestamp = ?6,
           revision = revision + 2, updated_at = 1
         WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 AND removed = 0`,
      ).bind(e.chainId, e.txHash, e.logIndex, e.blockNumber, e.blockHash, e.blockTimestampSec),
    ),
  );
  return moved;
}

/** A later poll no longer finds the logs (core.ts's MARK_REMOVED; the trigger queues the removal). */
async function drop(evts: ChainEvent[]): Promise<void> {
  await env.DB.batch(
    evts.map((e) =>
      env.DB.prepare(
        `UPDATE chain_events SET removed = 1, revision = revision + 1,
           dispatched_revision = revision + 1, updated_at = 2
         WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 AND removed = 0`,
      ).bind(e.chainId, e.txHash, e.logIndex),
    ),
  );
}

describe('W7-F1 R13: a veto re-mined within one poll, then removed for good', () => {
  it('a refund-proposal veto: refund_proposed again with its claimsOpenAt and its record current, and its finalize refunds', async () => {
    // A tie: refund rule 3.
    const r = await seedStakes([0, 1, 0, 1]);
    await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    const proposed = await stakesMode(r.roundId);
    expect(proposed).toMatchObject({ status: 'refund_proposed', refund_reason: 3 });
    const veto = vetoEvents(r, false);
    await mirror(veto);
    await dispatch();
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'revealing' });

    // One poll: the veto's block leaves the chain and its transaction lands two blocks later. Its
    // removal is skipped (live again); the re-mined veto finds the proposal vetoed already.
    r.chain.head += 2;
    const again = await remine(r, veto, r.chain.head);
    await dispatch();
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'revealing' });
    expect((await stakesRecords(r.roundId)).map((x) => x.superseded_at === null)).toEqual([false]);

    // A later poll: the veto is gone for good, so the refund proposal is live onchain again.
    await drop(again);
    await dispatch();
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'refund_proposed',
      refund_reason: 3,
      claims_open_at: proposed?.claims_open_at,
      final_at: null,
    });
    expect((await stakesRecords(r.roundId)).map((x) => x.superseded_at)).toEqual([null]);

    await index(finalizeEvents(r, 3));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 3 });
    expect(await kinds(r.roundId)).toEqual(['refund', 'refund', 'refund', 'refund']);
  });

  it('a settlement veto: settle_proposed again with its record current and no refunds, and RoundFinalized settles it', async () => {
    const r = await seedStakes([0, 1, 1]);
    await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    const proposed = await stakesMode(r.roundId);
    const veto = vetoEvents(r, true);
    await mirror(veto);
    await dispatch();
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 5 });
    expect(await kinds(r.roundId)).toEqual(['refund', 'refund', 'refund']);

    r.chain.head += 2;
    const again = await remine(r, veto, r.chain.head);
    await dispatch();
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 5 });

    await drop(again);
    await dispatch();
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'settle_proposed',
      refund_reason: null,
      final_at: null,
      claims_open_at: proposed?.claims_open_at,
    });
    expect((await stakesRecords(r.roundId)).map((x) => x.superseded_at)).toEqual([null]);
    expect(await stakesPayouts(r.roundId)).toEqual([]);

    const captured = captureAlerts();
    await index(finalizeEvents(r, null));
    captured.restore();
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'settled' });
    expect(await kinds(r.roundId)).toEqual(['win']);
    expect(captured.alerts.map((a) => a.step)).not.toContain('stakes_finalized_unknown');
  });
});

describe('W7-F1 R15: round_modes.bundle_hash is the chain’s', () => {
  it('stays null once the proposer has recorded and posted its proposal, until OutcomeProposed is indexed', async () => {
    const r = await seedStakes([0, 1, 1]);
    await toProposing(r);
    const records = await stakesRecords(r.roundId);
    expect(records).toHaveLength(1);
    expect(records[0]?.tx_hash).toBe(r.chain.lastTx('propose'));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'revealing', bundle_hash: null });

    const [proposed] = eventsOf(r.chain, r.chain.lastTx('propose'));
    if (!proposed) throw new Error('no OutcomeProposed');
    await index([proposed]);
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'settle_proposed',
      bundle_hash: String(proposed.args.bundleHash).toLowerCase(),
    });
    expect(records[0]?.bundle_hash).toBe(String(proposed.args.bundleHash).toLowerCase());
  });
});

describe('W7-F1 R16: OutcomeProposed.payoutRoot is the record’s', () => {
  it('another root alerts and is not confirmed (no status, revealed_at or bundle hash); the record’s root confirms it', async () => {
    const r = await seedStakes([0, 1, 1]);
    await toProposing(r);
    const [proposed] = eventsOf(r.chain, r.chain.lastTx('propose'));
    if (!proposed) throw new Error('no OutcomeProposed');
    const root = String(proposed.args.payoutRoot);
    expect(root).not.toBe(`0x${'00'.repeat(32)}`);

    const captured = captureAlerts();
    const forged = randomHash();
    await index([{ ...proposed, args: { ...proposed.args, payoutRoot: forged } }]);
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'revealing',
      revealed_at: null,
      claims_open_at: null,
    });
    expect(captured.alerts.filter((a) => a.step === 'stakes_proposal_root_mismatch')).toEqual([
      expect.objectContaining({
        code: 'ALERT_DO_ERROR',
        payoutRoot: forged,
        recorded: root.toLowerCase(),
        txHash: proposed.txHash,
      }),
    ]);

    await index([proposed]);
    captured.restore();
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'settle_proposed' });
    expect(captured.alerts.filter((a) => a.step === 'stakes_proposal_root_mismatch')).toHaveLength(
      1,
    );
  });

  it('a refund proposal posts the zero root, and its record has none: confirmed without an alert', async () => {
    const r = await seedStakes([0, 1, 0, 1]);
    await toProposing(r);
    const [proposed] = eventsOf(r.chain, r.chain.lastTx('propose'));
    if (!proposed) throw new Error('no OutcomeProposed');
    expect(String(proposed.args.payoutRoot)).toBe(`0x${'00'.repeat(32)}`);
    const captured = captureAlerts();
    await index([proposed]);
    captured.restore();
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refund_proposed' });
    expect(captured.alerts.map((a) => a.step)).not.toContain('stakes_proposal_root_mismatch');
  });
});
