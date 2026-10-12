// Stakes rounds for the read tests, settled by the real coordinator against the fake escrow chain
// (test/settlement/stakes-helpers.ts) and indexed by the real handlers: proposed, finalized, or
// refunded (refundTooFew).
import { env } from 'cloudflare:test';
import type { Hex } from 'viem';
import type { ChainEvent } from '../../src/indexer/types.js';
import { BEACON_TIME_MS } from '../settlement/helpers.js';
import { chainEventOf, eventsOf } from '../settlement/stakes-chain.js';
import {
  index,
  setGameClock,
  stakesHarness,
  type SeededStakes,
  type StakesHarness,
} from '../settlement/stakes-helpers.js';

async function follow(h: StakesHarness, phase: string): Promise<void> {
  for (let i = 0; i < 6; i++) if ((await h.alarm()).phase === phase) return;
  throw new Error(`the settlement never reached ${phase}`);
}

/**
 * seedStakes stores placeholder times (`created_at` 1): give each entry its block's time, as the
 * `Entered` handler does (src/lifecycle/handlers.ts), so responses pass the wire schemas.
 */
export async function entryTimes(r: SeededStakes): Promise<SeededStakes> {
  await env.DB.batch(
    r.entries.map((e) =>
      env.DB.prepare('UPDATE entries SET created_at = ?2 WHERE id = ?1').bind(
        e.id,
        r.chain.timeOf(e.block) * 1000,
      ),
    ),
  );
  return r;
}

/** Past close and the beacon: decrypted, proposed onchain, and the proposal indexed. */
export async function propose(r: SeededStakes): Promise<StakesHarness> {
  r.chain.advanceTo(r.closesAt / 1000 + 4);
  setGameClock(BEACON_TIME_MS + 5_000);
  const h = await stakesHarness(r);
  await h.start();
  await h.alarm();
  await h.deliver();
  const s = await h.alarm();
  if (s.phase !== 'proposing') throw new Error(`propose: ${s.phase} ${s.error ?? ''}`);
  await index(eventsOf(r.chain, r.chain.lastTx('propose')));
  return h;
}

/** At claimsOpenAt: finalized onchain (settled, or a refund proposal refunded) and indexed. */
export async function finalize(r: SeededStakes, h: StakesHarness): Promise<void> {
  const at = r.chain.round(r.chainRoundId).claimsOpenAt;
  setGameClock(at * 1000);
  r.chain.advanceTo(at);
  await follow(h, 'done');
  await index(eventsOf(r.chain, r.chain.lastTx('finalize')));
}

/** Fewer entries than minEntrants: refundTooFew after close, indexed (refund reason 1). */
export async function refundTooFew(r: SeededStakes): Promise<void> {
  r.chain.advanceTo(r.closesAt / 1000 + 4);
  setGameClock(r.closesAt + 5_000);
  const h = await stakesHarness(r);
  await h.start();
  await follow(h, 'done');
  await index(eventsOf(r.chain, r.chain.lastTx('refundTooFew')));
}

/** The round's Stakes `payout_root` and `bundle_hash` (current record) and its R2 manifest. */
export async function stakesRecord(roundId: string) {
  const rec = await env.DB.prepare(
    `SELECT payout_root, bundle_hash, tx_hash, settled_at FROM settlements
     WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL`,
  )
    .bind(roundId)
    .first<{
      payout_root: Hex | null;
      bundle_hash: Hex;
      tx_hash: Hex;
      settled_at: number | null;
    }>();
  const obj = await env.BUCKET.get(`bundles/${roundId}/stakes/manifest.json`);
  const manifest = obj
    ? await obj.json<{ payoutRoot: Hex | null; chainRoundId: string | null }>()
    : null;
  return { rec, manifest };
}

let claimTx = 0;

/** A `Claimed` / `RefundClaimed` log for `player` (FlockedEscrow `Kind`: win 0, rebate 1, void 2). */
export function claimEvent(
  r: SeededStakes,
  player: Hex,
  claim: { kind: 0 | 1 | 2; amount: bigint } | { refund: bigint },
): ChainEvent {
  claimTx += 1;
  const txHash: Hex = `0x${claimTx.toString(16).padStart(64, 'c')}`;
  const at = { txHash, block: r.chain.head };
  return 'refund' in claim
    ? chainEventOf(
        r.chain,
        'RefundClaimed',
        { roundId: r.chainRoundId, player, amount: claim.refund },
        at,
      )
    : chainEventOf(
        r.chain,
        'Claimed',
        { roundId: r.chainRoundId, player, kind: claim.kind, amount: claim.amount },
        at,
      );
}
