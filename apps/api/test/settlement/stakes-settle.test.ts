// Stakes settlement end to end against a fake Base node (W6-A): the entry set streamed from close and
// reconciled at the close block (ALERT-1), the safe-head wait (ALERT-3), the proposal and its
// amounts (NFR-4, part), idempotent proposing (NFR-6), finalize at claimsOpenAt with the payouts,
// refundTooFew, the vetoes (SET-1b rule 5, and a refund proposal settling again), refundTimeout
// (SET-1b rule 6), and a proposal a reorg removed being posted again.
import { env, runInDurableObject } from 'cloudflare:test';
import { stakesPayoutTree, type StakesLeafKind } from '@flocked/settle';
import { newUlid } from '@flocked/shared';
import { bytesToHex, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENTRY_SET_ALERT_MS, type SettlementDO } from '../../src/do/settlement-do.js';
import { applyStakes } from '../../src/settlement/apply/stakes.js';
import { BEACON_TIME_MS, alertSpy } from './helpers.js';
import { STATUS, chainEventOf, eventsOf } from './stakes-chain.js';
import {
  entryRow,
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

const HOUR = 3_600_000;
const randomHash = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const KIND: Record<string, StakesLeafKind> = { win: 0, rebate: 1, void_refund: 2 };

beforeEach(() => {
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The close block on the fake chain: the last block stamped before closesAt. */
function closeBlockOf(r: SeededStakes): number {
  let n = r.chain.head;
  while (r.chain.timeOf(n) >= r.closesAt / 1000) n -= 1;
  return n;
}

/** Past close with the safe head past the close block, after the beacon: start → proposing. */
async function toProposing(r: SeededStakes, opts: { fallback?: boolean } = {}) {
  r.chain.advanceTo(r.closesAt / 1000 + 4);
  setGameClock(BEACON_TIME_MS + 5_000);
  const h = await stakesHarness(r, opts);
  await h.start();
  expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
  await h.deliver();
  expect(await h.alarm()).toMatchObject({ phase: 'proposing', error: null });
  return h;
}

/** The guardian's veto, as the indexer sees it (a vetoed settlement is refunded in the same tx). */
function vetoEvents(r: SeededStakes, refunded: boolean) {
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

async function followTo(h: StakesHarness, phase: string) {
  for (let i = 0; i < 5; i++) if ((await h.alarm()).phase === phase) return;
  throw new Error(`the job never reached ${phase}`);
}

describe('Stakes settlement from close to final', () => {
  it('streams, waits for the safe head (ALERT-3), proposes with settle’s amounts, and settles at claimsOpenAt with payouts; a foreign winner is paid only through the tree', async () => {
    // Option 0 is the minority. Entry 1 (a winner) is foreign: no ticket, so no user.
    const r = await seedStakes([0, 0, 1, 1, 1, 'void'], {
      stakes: { capMultiple: 1 },
      foreign: [1],
    });
    const alerts = alertSpy();
    const lag = () => alerts.codes().filter((c) => c === 'ALERT_SAFE_HEAD_LAG').length;
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    r.chain.safeLag = 100;
    setGameClock(r.closesAt + 1_000);
    const h = await stakesHarness(r);
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'preparing', chunksTotal: 0 });
    // The safe head isn't past the close block: nothing is read past it and nothing is posted.
    setGameClock(BEACON_TIME_MS + 59_000);
    await h.alarm();
    expect(lag()).toBe(0);
    setGameClock(BEACON_TIME_MS + 60_000);
    await h.alarm();
    await h.alarm();
    expect(lag()).toBe(1);
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'pending' });
    expect(r.chain.calls).toEqual([]);

    r.chain.safeLag = 0;
    expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'revealing' });
    await h.deliver();
    expect(await h.alarm()).toMatchObject({ phase: 'proposing', error: null });
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`]);

    const result = h.applied[0];
    if (!result) throw new Error('not applied');
    const close = closeBlockOf(r);
    expect(result.manifest.closeBlock).toEqual({ number: close, hash: r.chain.hashOf(close) });
    // NFR-4 (part): the amounts the contract derives from the posted headcounts are settle's.
    const onchain = r.chain.round(r.chainRoundId);
    const amount = (kind: string) => result.payouts.find((p) => p.kind === kind)?.amount ?? 0n;
    expect(onchain.n).toEqual([2, 3, 1]);
    expect(onchain.payoutRoot).toBe(result.manifest.payoutRoot);
    expect(onchain.bundleHash).toBe(result.bundleHash);
    expect(onchain.amounts).toEqual({
      winPayout: amount('win'),
      rebatePayout: amount('rebate'),
      fee: result.record.fee,
      creatorFee: result.record.creatorFee,
      dust: result.record.dust,
    });
    expect(amount('rebate')).toBeGreaterThan(0n);

    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    const proposed = await stakesMode(r.roundId);
    expect(proposed).toMatchObject({
      status: 'settle_proposed',
      claims_open_at: onchain.claimsOpenAt * 1000,
      bundle_hash: result.bundleHash,
    });
    expect(proposed?.revealed_at).toBeGreaterThan(0);
    expect(await stakesPayouts(r.roundId)).toEqual([]);

    // Before claimsOpenAt nothing is sent; at it, finalize.
    setGameClock(onchain.claimsOpenAt * 1000 - 1_000);
    await h.alarm();
    expect(r.chain.calls).toHaveLength(1);
    setGameClock(onchain.claimsOpenAt * 1000);
    r.chain.advanceTo(onchain.claimsOpenAt);
    await followTo(h, 'done');
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`, `finalize:${r.chainRoundId}`]);
    expect(r.chain.round(r.chainRoundId).status).toBe(STATUS.Settled);

    await index(eventsOf(r.chain, r.chain.lastTx('finalize')));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'settled' });
    expect((await stakesMode(r.roundId))?.final_at).toBeGreaterThan(0);
    const foreign = r.entries[1]?.wallet;
    const expected = result.payouts
      .filter((p) => p.account !== foreign)
      .map((p) => ({ wallet: p.account, kind: p.kind, amount: Number(p.amount) }))
      .sort((a, b) => a.wallet.localeCompare(b.wallet) || a.kind.localeCompare(b.kind));
    const rows = await stakesPayouts(r.roundId);
    expect(rows.map(({ wallet, kind, amount }) => ({ wallet, kind, amount }))).toEqual(expected);
    expect(rows.every((p) => p.user_id !== null)).toBe(true);
    // The foreign winner's leaf is in the tree, so its wallet claims onchain like any other.
    expect(result.payouts.some((p) => p.account === foreign && p.kind === 'win')).toBe(true);
    const tree = stakesPayoutTree(
      r.chainRoundId,
      result.payouts.map((p) => ({
        account: p.account as Hex,
        kind: KIND[p.kind] as StakesLeafKind,
      })),
    );
    expect(tree.root).toBe(result.manifest.payoutRoot);
    expect(tree.proof(foreign as Hex, 0).length).toBeGreaterThan(0);
  });
});

describe('ALERT-1: the entry set is reconciled before anything is posted', () => {
  it('a mismatch on the primary provider alerts and is read again from the fallback, which reconciles', async () => {
    const r = await seedStakes([0, 1, 1]);
    r.chain.dropLogs.primary.add(r.entries[1]?.txHash as Hex);
    const alerts = alertSpy();
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    setGameClock(BEACON_TIME_MS + 5_000);
    const h = await stakesHarness(r, { fallback: true });
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'preparing' });
    expect(alerts.codes()).toEqual(['ALERT_SETTLEMENT_FAILED']);
    expect(r.chain.requests.get('fallback:eth_getLogs') ?? 0).toBe(0);
    expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
    expect(r.chain.requests.get('fallback:eth_getLogs')).toBeGreaterThan(0);
    await h.deliver();
    expect(await h.alarm()).toMatchObject({ phase: 'proposing' });
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`]);
    expect(alerts.codes()).toEqual(['ALERT_SETTLEMENT_FAILED']);
  });

  it('a mismatch on both providers alerts, posts nothing and keeps the round Open; refundTimeout ends it at closesAt + 72 h (SET-1b rule 6)', async () => {
    const r = await seedStakes([0, 1, 1]);
    const dropped = r.entries[2]?.txHash as Hex;
    r.chain.dropLogs.primary.add(dropped);
    r.chain.dropLogs.fallback.add(dropped);
    const alerts = alertSpy();
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    setGameClock(BEACON_TIME_MS + 5_000);
    const h = await stakesHarness(r, { fallback: true });
    await h.start();
    await h.alarm();
    const failed = await h.alarm();
    expect(failed.phase).toBe('failed');
    expect(failed.error).toMatch(/^fallback: 2 Entered logs .* entryCount 3/);
    expect(alerts.codes()).toEqual(['ALERT_SETTLEMENT_FAILED', 'ALERT_SETTLEMENT_FAILED']);
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'pending' });
    expect(r.chain.calls).toEqual([]);
    expect(await env.BUCKET.list({ prefix: `bundles/${r.roundId}/` })).toMatchObject({
      objects: [],
    });

    // The backstop: still Open at the refund timeout, refundTimeout (anyone may call it).
    await h.alarm();
    expect(r.chain.calls).toEqual([]);
    setGameClock(r.closesAt + 72 * HOUR);
    r.chain.advanceTo(r.closesAt / 1000 + 72 * 3600);
    await h.alarm();
    expect(r.chain.calls).toEqual([`refundTimeout:${r.chainRoundId}`]);
    await index(eventsOf(r.chain, r.chain.lastTx('refundTimeout')));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 6 });
    const refunds = await stakesPayouts(r.roundId);
    expect(refunds.map((p) => [p.kind, p.amount])).toEqual(
      r.entries.map(() => ['refund', Number(r.stake)]),
    );
  });
});

describe('D1 against the streamed entry set', () => {
  it('waits while the indexer hasn’t stored every streamed entry, then settles exactly that set', async () => {
    const r = await seedStakes([0, 1, 1], { d1: false });
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    setGameClock(BEACON_TIME_MS + 5_000);
    const h = await stakesHarness(r);
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'preparing' });
    // Two of the three stored: still waiting, nothing decrypted or posted.
    await env.DB.batch(r.entries.slice(0, 2).map((e) => entryRow(r.roundId, r.stake, e)));
    expect(await h.alarm()).toMatchObject({ phase: 'preparing', chunksTotal: 0 });
    // The right count, but the third row isn't the chain's (a reorged-out entry not yet removed).
    const third = r.entries[2];
    if (!third) throw new Error('no third entry');
    const stale = { ...third, id: newUlid(), userId: newUlid(), txHash: randomHash() };
    await entryRow(r.roundId, r.stake, stale).run();
    expect(await h.alarm()).toMatchObject({ phase: 'preparing', chunksTotal: 0 });
    expect(r.chain.calls).toEqual([]);
    // Still waiting 10 minutes on: it alerts, once.
    const alerts = alertSpy();
    await runInDurableObject(h.stub, async (o: SettlementDO, state) => {
      const job = await state.storage.get<{ entrySetWaitSince: number }>('job');
      if (!job) throw new Error('no job');
      job.entrySetWaitSince -= ENTRY_SET_ALERT_MS;
      await state.storage.put('job', job);
      Reflect.set(o, 'job', undefined);
    });
    await h.alarm();
    await h.alarm();
    expect(alerts.codes()).toEqual(['ALERT_SETTLEMENT_FAILED']);
    await env.DB.prepare('DELETE FROM entries WHERE id = ?1').bind(stale.id).run();
    await env.DB.batch(r.entries.slice(2).map((e) => entryRow(r.roundId, r.stake, e)));
    expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
    await h.deliver();
    expect(await h.alarm()).toMatchObject({ phase: 'proposing' });
    expect(h.applied[0]?.entries.map((e) => e.account)).toEqual(r.entries.map((e) => e.wallet));
  });
});

describe('NFR-6 (Stakes): proposing is idempotent', () => {
  it('a proposal still pending is polled, never posted again, and a later apply checks the chain first', async () => {
    const r = await seedStakes([0, 1, 1]);
    r.chain.automine = false;
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    setGameClock(BEACON_TIME_MS + 5_000);
    const h = await stakesHarness(r);
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
    await h.deliver();
    expect(await h.alarm()).toMatchObject({ phase: 'applying' });
    expect(r.chain.pool.size).toBe(1);
    expect(await h.alarm()).toMatchObject({ phase: 'applying' });
    expect(await h.alarm()).toMatchObject({ phase: 'applying' });
    expect(r.chain.pool.size).toBe(1);

    await r.chain.mine();
    expect(await h.alarm()).toMatchObject({ phase: 'proposing' });
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`]);
    const result = h.applied[0];
    if (!result) throw new Error('not applied');
    r.chain.automine = true;
    await applyStakes(env, result, {
      operator: { transport: r.chain.transport(), waitMs: 0 },
      escrow: { transports: { primary: r.chain.transport() } },
    });
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`]);
    const { results } = await env.DB.prepare(
      "SELECT purpose FROM operator_txs WHERE purpose LIKE 'propose:' || ?1 || ':%'",
    )
      .bind(r.roundId)
      .all<{ purpose: string }>();
    expect(results).toEqual([{ purpose: `propose:${r.roundId}:0` }]);
    expect(await stakesRecords(r.roundId)).toHaveLength(1);
  });
});

describe('Stakes refunds and vetoes', () => {
  it('fewer entries than minEntrants: refundTooFew after close, no reveal (rule 1)', async () => {
    const r = await seedStakes([0, 1]);
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    setGameClock(r.closesAt + 5_000);
    const h = await stakesHarness(r);
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'proposing' });
    await followTo(h, 'done');
    expect(r.chain.calls).toEqual([`refundTooFew:${r.chainRoundId}`]);
    expect(h.applied).toHaveLength(0);
    await index(eventsOf(r.chain, r.chain.lastTx('refundTooFew')));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 1 });
    expect(await stakesPayouts(r.roundId)).toHaveLength(2);
  });

  it('a vetoed settlement is refunded with reason 5, its record superseded (SET-1b rule 5)', async () => {
    const r = await seedStakes([0, 1, 1]);
    const h = await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'settle_proposed' });
    const alerts = alertSpy();
    await index(vetoEvents(r, true));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 5 });
    const records = await stakesRecords(r.roundId);
    expect(records).toHaveLength(1);
    expect(records[0]?.superseded_at).not.toBeNull();
    const refunds = await stakesPayouts(r.roundId);
    expect(refunds.map((p) => p.kind)).toEqual(['refund', 'refund', 'refund']);
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE target = ?1 AND action = 'proposal_vetoed'",
    )
      .bind(r.roundId)
      .all();
    expect(audit.results).toHaveLength(1);
    expect(alerts.codes()).not.toContain('ALERT_SETTLEMENT_FAILED');
    await followTo(h, 'done');
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`]);
  });

  it('a vetoed refund proposal returns the mode to revealing, alerts, and it settles again', async () => {
    // A tie: refund rule 3, so a refund proposal with no payout tree.
    const r = await seedStakes([0, 1, 0, 1]);
    const h = await toProposing(r);
    expect(h.applied[0]?.manifest.payoutRoot).toBeNull();
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'refund_proposed',
      refund_reason: 3,
    });

    const alerts = alertSpy();
    await index(vetoEvents(r, false));
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'revealing',
      refund_reason: null,
      claims_open_at: null,
    });
    expect(alerts.codes()).toContain('ALERT_DO_ERROR');
    expect((await stakesRecords(r.roundId))[0]?.superseded_at).not.toBeNull();

    // The coordinator sees the round Open again and posts the next proposal.
    expect(await h.alarm()).toMatchObject({ phase: 'proposing', error: null });
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`, `propose:${r.chainRoundId}`]);
    expect(r.chain.round(r.chainRoundId).status).toBe(STATUS.RefundProposed);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refund_proposed' });
    const records = await stakesRecords(r.roundId);
    expect(records.map((x) => [x.proposal_seq, x.superseded_at === null])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(records[0]?.bundle_hash).toBe(records[1]?.bundle_hash);

    // Final at claimsOpenAt: refunded (rule 3), with the refunds.
    const at = r.chain.round(r.chainRoundId).claimsOpenAt;
    setGameClock(at * 1000);
    r.chain.advanceTo(at);
    await followTo(h, 'done');
    await index(eventsOf(r.chain, r.chain.lastTx('finalize')));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 3 });
    expect(await stakesPayouts(r.roundId)).toHaveLength(4);
  });

  it('a proposal a reorg removed (not re-mined) is posted again', async () => {
    const r = await seedStakes([0, 1, 1]);
    const h = await toProposing(r);
    const [proposed] = eventsOf(r.chain, r.chain.lastTx('propose'));
    if (!proposed) throw new Error('no OutcomeProposed');
    await index([proposed]);
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'settle_proposed' });
    // The block left the chain and the transaction with it: the round is Open again onchain.
    Object.assign(r.chain.round(r.chainRoundId), {
      status: STATUS.Open,
      bundleHash: `0x${'00'.repeat(32)}`,
    });
    await index([{ ...proposed, removed: true, revision: 1 }]);
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'revealing' });
    expect(await h.alarm()).toMatchObject({ phase: 'proposing', error: null });
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`, `propose:${r.chainRoundId}`]);
    expect(r.chain.round(r.chainRoundId).status).toBe(STATUS.SettleProposed);
  });
});
