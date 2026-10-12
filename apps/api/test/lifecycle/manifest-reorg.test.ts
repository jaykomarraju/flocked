// W6-A: a confirmed Free manifest anchor whose `ManifestAnchored` a reorg removed is handed back to the
// AnchorDO by the indexer's handler, which checks the chain again and resends it; one re-mined
// elsewhere changes nothing. Its own file: the AnchorDO singleton keeps its storage for the whole file.
import { env } from 'cloudflare:test';
import { flockedAnchorAbi } from '@flocked/abi';
import { roundKey } from '@flocked/shared';
import { decodeFunctionData, keccak256, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { handlers } from '../../src/indexer/handlers.js';
import { anchorConfirmationHandler } from '../../src/lifecycle/handlers.js';
import { FAKE_ANCHOR } from '../anchor-do/fake-chain.js';
import { createRound } from '../round-do/helpers.js';
import { chainHarness, setClock } from '../scheduler/helpers.js';
import { chainEvent, commitStatements } from './helpers.js';

const ZERO32: Hex = `0x${'00'.repeat(32)}`;
const ctx = { rpc: null as never };

/** Mirrors one live anchor log, as the indexer would have. */
function mirror(event: string, txHash: Hex, args: Record<string, unknown>, block = 50) {
  return env.DB.prepare(
    `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash,
       log_index, event, args_json, created_at, updated_at)
     VALUES (31337, ?1, ?2, ?3, 1, ?4, 0, ?5, ?6, 0, 0)`,
  )
    .bind(
      FAKE_ANCHOR,
      block,
      keccak256(stringToHex(`block ${block}`)),
      txHash,
      event,
      JSON.stringify(args),
    )
    .run();
}

async function settlementTx(roundId: string): Promise<string | null | undefined> {
  const row = await env.DB.prepare(
    "SELECT tx_hash FROM settlements WHERE round_id = ?1 AND mode = 'free'",
  )
    .bind(roundId)
    .first<{ tx_hash: string | null }>();
  return row?.tx_hash;
}

/**
 * A settled Free round locked onchain (its `Locked` mirrored) whose manifest the AnchorDO anchored,
 * with its settlement record holding that transaction.
 */
async function anchoredManifest() {
  const r = await createRound({ modes: ['free'] });
  const l = r.locked;
  const key = roundKey(l.roundId, 'free');
  const closesAtSec = l.closesAt / 1000;
  const t = l.beaconTimeSec * 1000 + 5_000;
  const h = await chainHarness(t);
  setClock(t);
  h.fake.anchors.set(key, {
    ...h.fake.anchorOf(key),
    closesAt: BigInt(closesAtSec),
    beaconRound: BigInt(l.beaconRound),
    lockedAt: BigInt(closesAtSec - 3600),
  });
  await mirror('Locked', keccak256(stringToHex(`lock ${l.roundId}`)), {
    roundKey: key,
    closesAt: String(closesAtSec),
  });
  const bundle = keccak256(stringToHex(`bundle ${l.roundId}`));
  await env.DB.prepare(
    `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json,
       bundle_hash, settled_at)
     VALUES (?1, 'free', 0, 'settled', 1, '[]', ?2, ?3)`,
  )
    .bind(l.roundId, bundle, t)
    .run();
  await h.anchor.submitManifest({
    roundKey: key,
    roundId: l.roundId,
    mode: 'free',
    manifestHash: bundle,
    beaconTimeSec: l.beaconTimeSec,
  });
  await h.runAnchor(); // sent (mined at once)
  await h.runAnchor(); // its receipt
  expect(h.fake.sent).toHaveLength(1);
  const first = h.fake.sent[0]!.hash;
  expect(await settlementTx(l.roundId)).toBe(first);
  return { h, roundId: l.roundId, key, bundle, first };
}

describe('a reorged-out manifest anchor', () => {
  it('the anchor-confirmation handler runs for ManifestAnchored', () => {
    expect(handlers.for('ManifestAnchored').map((x) => x.name)).toEqual([
      'alert-unsent-tx',
      'anchor-confirmation',
    ]);
  });

  it('clears the settlement record’s tx_hash and is anchored again, and the record follows', async () => {
    const { h, roundId, key, bundle, first } = await anchoredManifest();
    // A reorg drops the anchor: the indexer marks its ManifestAnchored log removed.
    h.fake.anchors.set(key, {
      ...h.fake.anchorOf(key),
      manifestAnchoredAt: 0n,
      manifestHash: ZERO32,
    });
    const removed = chainEvent(
      'anchor',
      'ManifestAnchored',
      { roundKey: key, manifestHash: bundle },
      { txHash: first, removed: true },
    );
    await commitStatements(await anchorConfirmationHandler(removed, env, ctx));
    expect(await settlementTx(roundId)).toBeNull();
    expect((await h.anchor.status(key)).manifest.state).toBe('queued');

    await h.runAnchor();
    await h.runAnchor();
    expect(h.fake.sent).toHaveLength(2);
    const second = h.fake.sent[1]!.hash;
    expect(decodeFunctionData({ abi: flockedAnchorAbi, data: h.fake.sent[1]!.data })).toMatchObject(
      {
        functionName: 'anchorManifest',
        args: [key, bundle],
      },
    );
    expect((await h.anchor.status(key)).manifest).toMatchObject({
      state: 'confirmed',
      txHash: second,
    });
    expect(h.fake.anchorOf(key).manifestHash).toBe(bundle);
    expect(await settlementTx(roundId)).toBe(second);
  });

  it('re-mined in another block (live again), it changes nothing', async () => {
    const { h, roundId, key, bundle, first } = await anchoredManifest();
    // The indexer has mirrored it again in its new block before it dispatches the removal.
    await mirror('ManifestAnchored', first, { roundKey: key, manifestHash: bundle }, 51);
    const removed = chainEvent(
      'anchor',
      'ManifestAnchored',
      { roundKey: key, manifestHash: bundle },
      { txHash: first, removed: true },
    );
    expect(await anchorConfirmationHandler(removed, env, ctx)).toBeUndefined();
    expect(await settlementTx(roundId)).toBe(first);
    expect((await h.anchor.status(key)).manifest).toMatchObject({
      state: 'confirmed',
      txHash: first,
    });
    await h.runAnchor();
    expect(h.fake.sent).toHaveLength(1);
  });

  it('a ManifestAnchored confirms the record of its own bundle while it has no transaction', async () => {
    const { roundId, key, bundle } = await anchoredManifest();
    await env.DB.prepare(
      "UPDATE settlements SET tx_hash = NULL WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(roundId)
      .run();
    const other = chainEvent('anchor', 'ManifestAnchored', {
      roundKey: key,
      manifestHash: keccak256(stringToHex('another bundle')),
    });
    await commitStatements(await anchorConfirmationHandler(other, env, ctx));
    expect(await settlementTx(roundId)).toBeNull();
    const ours = chainEvent('anchor', 'ManifestAnchored', { roundKey: key, manifestHash: bundle });
    await commitStatements(await anchorConfirmationHandler(ours, env, ctx));
    expect(await settlementTx(roundId)).toBe(ours.txHash);
  });
});
