// W6-F1 review fixes to Stakes settlement, against the fake Base node (stakes-chain.ts): a proposal
// re-mined after its removal was handled (R2); removed vetoes, finalizations and refunds putting D1
// back where a re-mined or replacing event needs it (R3); a pending proposal polled without
// rewriting its entries (R4); a primary provider without the close block's state (R5); and the
// settlement hold a vetoed refund proposal opens (O1, owner decision Oct 12).
import { env } from 'cloudflare:test';
import { bytesToHex, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainEvent } from '../../src/indexer/types.js';
import { ProposalHeldError, applyStakes } from '../../src/settlement/apply/stakes.js';
import { captureAlerts } from '../indexer/helpers.js';
import { BEACON_TIME_MS, alertSpy } from './helpers.js';
import { STATUS, chainEventOf, eventsOf } from './stakes-chain.js';
import {
  index,
  releaseHold,
  seedStakes,
  setGameClock,
  stakesEnv,
  stakesHarness,
  stakesHolds,
  stakesMode,
  stakesPayouts,
  stakesRecords,
  type SeededStakes,
  type StakesHarness,
} from './stakes-helpers.js';

const HOUR = 3_600_000;
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

/** A transaction's events leaving the chain, as the dispatcher hands them over (newest first). */
const removed = (evts: ChainEvent[]): ChainEvent[] =>
  [...evts].reverse().map((e) => ({ ...e, removed: true, revision: e.revision + 1 }));

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

describe('W6-F1 R2: a proposal re-mined after its removal was handled', () => {
  it('puts its record back, so the mode is settle_proposed again and RoundFinalized settles it', async () => {
    const r = await seedStakes([0, 1, 1]);
    await toProposing(r);
    const [proposed] = eventsOf(r.chain, r.chain.lastTx('propose'));
    if (!proposed) throw new Error('no OutcomeProposed');
    await index([proposed]);
    const before = await stakesMode(r.roundId);
    expect(before).toMatchObject({ status: 'settle_proposed' });

    // One poll: the block leaves the chain. A later poll: the transaction is mined again.
    await index(removed([proposed]));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'revealing' });
    expect((await stakesRecords(r.roundId))[0]?.superseded_at).not.toBeNull();
    const captured = captureAlerts();
    await index([{ ...proposed, blockNumber: proposed.blockNumber + 3, revision: 2 }]);
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'settle_proposed',
      claims_open_at: before?.claims_open_at,
      bundle_hash: before?.bundle_hash,
    });
    expect((await stakesRecords(r.roundId)).map((x) => [x.proposal_seq, x.superseded_at])).toEqual([
      [0, null],
    ]);

    await index(finalizeEvents(r, null));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'settled' });
    expect(await kinds(r.roundId)).toEqual(['win']);
    captured.restore();
    // Neither found no record (the RoundDO, not set up here, alerts its own step).
    expect(captured.alerts.map((a) => a.step)).not.toContain('stakes_proposal_unknown');
    expect(captured.alerts.map((a) => a.step)).not.toContain('stakes_finalized_unknown');
  });
});

describe('W6-F1 R3: a removed veto, finalization or refund puts D1 back', () => {
  it('a dropped settlement veto: settle_proposed again with no refund payouts, so a later RoundFinalized pays the settlement only', async () => {
    const r = await seedStakes([0, 1, 1]);
    await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    const proposed = await stakesMode(r.roundId);
    const veto = vetoEvents(r, true);
    await index(veto);
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 5 });
    expect(await kinds(r.roundId)).toEqual(['refund', 'refund', 'refund']);

    const alerts = alertSpy();
    await index(removed(veto));
    expect(alerts.codes()).toEqual(['ALERT_DO_ERROR', 'ALERT_DO_ERROR']);
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'settle_proposed',
      refund_reason: null,
      final_at: null,
      claims_open_at: proposed?.claims_open_at,
    });
    expect((await stakesRecords(r.roundId)).map((x) => x.superseded_at)).toEqual([null]);
    expect(await stakesPayouts(r.roundId)).toEqual([]);

    // No veto after all: the challenge window passes and the settlement is final.
    await index(finalizeEvents(r, null));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'settled' });
    expect(await kinds(r.roundId)).toEqual(['win']);
    expect(alerts.codes()).toHaveLength(2);
  });

  it('a dropped refund-proposal veto: refund_proposed again with its claimsOpenAt, and its finalize refunds', async () => {
    // A tie: refund rule 3.
    const r = await seedStakes([0, 1, 0, 1]);
    await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    const proposed = await stakesMode(r.roundId);
    expect(proposed).toMatchObject({ status: 'refund_proposed', refund_reason: 3 });
    const veto = vetoEvents(r, false);
    await index(veto);
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'revealing',
      claims_open_at: null,
    });

    await index(removed(veto));
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'refund_proposed',
      refund_reason: 3,
      claims_open_at: proposed?.claims_open_at,
      final_at: null,
    });
    expect((await stakesRecords(r.roundId)).map((x) => x.superseded_at)).toEqual([null]);
    // Only the guardian's admin action releases a hold: it stays open for them to release.
    expect((await stakesHolds(r.roundId)).map((x) => x.released_at)).toEqual([null]);

    await index(finalizeEvents(r, 3));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 3 });
    expect(await kinds(r.roundId)).toEqual(['refund', 'refund', 'refund', 'refund']);
  });

  it('a dropped RoundFinalized: settle_proposed again without its payouts; re-mined, it settles again', async () => {
    const r = await seedStakes([0, 1, 1]);
    await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    const finalized = finalizeEvents(r, null);
    await index(finalized);
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'settled' });
    expect(await kinds(r.roundId)).toEqual(['win']);

    await index(removed(finalized));
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'settle_proposed',
      final_at: null,
    });
    expect((await stakesRecords(r.roundId)).map((x) => x.settled_at)).toEqual([null]);
    expect(await stakesPayouts(r.roundId)).toEqual([]);

    await index(finalizeEvents(r, null));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'settled' });
    expect(await kinds(r.roundId)).toEqual(['win']);
  });

  it('a dropped refundTooFew: pending again without its refunds; re-mined, it refunds again', async () => {
    const r = await seedStakes([0, 1]);
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    setGameClock(r.closesAt + 5_000);
    const h = await stakesHarness(r);
    await h.start();
    for (let i = 0; i < 5 && (await h.alarm()).phase !== 'done'; i++);
    const refunded = eventsOf(r.chain, r.chain.lastTx('refundTooFew'));
    await index(refunded);
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 1 });
    expect(await kinds(r.roundId)).toEqual(['refund', 'refund']);

    await index(removed(refunded));
    expect(await stakesMode(r.roundId)).toMatchObject({
      status: 'pending',
      refund_reason: null,
      final_at: null,
      revealed_at: null,
    });
    expect(await stakesPayouts(r.roundId)).toEqual([]);

    await index(refunded.map((e) => ({ ...e, revision: e.revision + 2 })));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 1 });
    expect(await kinds(r.roundId)).toEqual(['refund', 'refund']);
  });
});

describe('W6-F1 R4: a pending proposal polled again writes nothing', () => {
  it('leaves the entries and the record as the first call wrote them', async () => {
    const r = await seedStakes([0, 1, 1]);
    r.chain.automine = false;
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    setGameClock(BEACON_TIME_MS + 5_000);
    const h = await stakesHarness(r);
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
    await h.deliver();
    expect(await h.alarm()).toMatchObject({ phase: 'applying' });
    const first = r.entries[0];
    if (!first) throw new Error('no entry');
    const entry = () =>
      env.DB.prepare('SELECT option_index, valid FROM entries WHERE id = ?1')
        .bind(first.id)
        .first<{ option_index: number; valid: number }>();
    expect(await entry()).toEqual({ option_index: 0, valid: 1 });
    // Markers the next call would overwrite if it wrote the entries or the record again.
    await env.DB.batch([
      env.DB.prepare('UPDATE entries SET option_index = 1 WHERE id = ?1').bind(first.id),
      env.DB.prepare(
        "UPDATE round_modes SET bundle_hash = 'untouched' WHERE round_id = ?1 AND mode = 'stakes'",
      ).bind(r.roundId),
    ]);

    expect(await h.alarm()).toMatchObject({ phase: 'applying' });
    expect(await h.alarm()).toMatchObject({ phase: 'applying' });
    expect(h.applied).toHaveLength(3);
    expect(await entry()).toEqual({ option_index: 1, valid: 1 });
    expect((await stakesMode(r.roundId))?.bundle_hash).toBe('untouched');
    expect(r.chain.pool.size).toBe(1);
  });
});

describe('W6-F1 R5: a primary provider without the close block’s state', () => {
  it('is a provider failure: the entry set is read again from the fallback, which reconciles', async () => {
    const r = await seedStakes([0, 1, 1]);
    r.chain.noArchive.add('primary');
    const alerts = alertSpy();
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    setGameClock(BEACON_TIME_MS + 5_000);
    const h = await stakesHarness(r, { fallback: true });
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'preparing', error: null });
    expect(r.chain.requests.get('fallback:eth_getLogs') ?? 0).toBe(0);
    expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
    expect(r.chain.requests.get('fallback:eth_getLogs')).toBeGreaterThan(0);
    expect(r.chain.requests.get('fallback:eth_call')).toBeGreaterThan(0);
    await h.deliver();
    expect(await h.alarm()).toMatchObject({ phase: 'proposing' });
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`]);
    // A provider failure, not an integrity mismatch: no page.
    expect(alerts.codes()).toEqual([]);
  });
});

describe('W6-F1 O1: a vetoed refund proposal holds settlement for the guardian', () => {
  it('a settlement veto opens no hold', async () => {
    const r = await seedStakes([0, 1, 1]);
    await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    await index(vetoEvents(r, true));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 5 });
    expect(await stakesHolds(r.roundId)).toEqual([]);
  });

  it('a proposal the coordinator would post after its own hold check, with the veto indexed meanwhile, waits', async () => {
    const r = await seedStakes([0, 1, 0, 1]);
    const h = await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    await index(vetoEvents(r, false));
    const result = h.applied[0];
    if (!result) throw new Error('not applied');
    await expect(
      applyStakes(env, result, {
        operator: { transport: r.chain.transport(), waitMs: 0 },
        escrow: { transports: { primary: r.chain.transport() } },
      }),
    ).rejects.toBeInstanceOf(ProposalHeldError);
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`]);
    expect(await stakesRecords(r.roundId)).toHaveLength(1);
  });

  it('refundTimeout still ends a held round at closesAt + 72 h', async () => {
    const r = await seedStakes([0, 1, 0, 1]);
    const h = await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    await index(vetoEvents(r, false));
    await h.alarm();
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`]);
    setGameClock(r.closesAt + 72 * HOUR);
    r.chain.advanceTo(r.closesAt / 1000 + 72 * 3600);
    await h.alarm();
    expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`, `refundTimeout:${r.chainRoundId}`]);
    await index(eventsOf(r.chain, r.chain.lastTx('refundTimeout')));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 6 });
  });

  it('a second refund veto of the same round reopens the hold the guardian released', async () => {
    const r = await seedStakes([0, 1, 0, 1]);
    const h = await toProposing(r);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    const first = vetoEvents(r, false);
    await index(first);
    await releaseHold(r.roundId, 'refund_vetoed');
    expect(await h.alarm()).toMatchObject({ phase: 'proposing', error: null });
    expect(r.chain.calls).toHaveLength(2);
    await index(eventsOf(r.chain, r.chain.lastTx('propose')));
    expect(await stakesMode(r.roundId)).toMatchObject({ status: 'refund_proposed' });

    const alerts = alertSpy();
    const second = vetoEvents(r, false);
    await index(second);
    expect(alerts.codes()).toEqual(['ALERT_DO_ERROR']);
    const row = await env.DB.prepare(
      "SELECT created_at, released_at, released_by, tx_hash FROM settlement_holds WHERE round_id = ?1 AND mode = 'stakes' AND reason = 'refund_vetoed'",
    )
      .bind(r.roundId)
      .first();
    expect(row).toEqual({
      created_at: (second[0]?.blockTimestampSec ?? 0) * 1000,
      released_at: null,
      released_by: null,
      tx_hash: null,
    });
    expect(row?.created_at).toBeGreaterThan((first[0]?.blockTimestampSec ?? 0) * 1000);
    // Held again: nothing more is posted.
    await h.alarm();
    await h.alarm();
    expect(r.chain.calls).toHaveLength(2);
  });
});
