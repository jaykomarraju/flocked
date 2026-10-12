// W4-F1 N2: a Free commitment whose `Committed` write a reorg removed is handed back to the AnchorDO
// by the indexer's handler, which checks the chain again and resends it. Its own file: the AnchorDO
// singleton keeps its storage for the whole file.
import { env } from 'cloudflare:test';
import { roundKey } from '@flocked/shared';
import { beaconTime } from '@flocked/tlock';
import { keccak256, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { AnchorCommitItem } from '../../src/do/types.js';
import { anchorConfirmationHandler } from '../../src/lifecycle/handlers.js';
import { FAKE_ANCHOR } from '../anchor-do/fake-chain.js';
import { chain as drand, createRound } from '../round-do/helpers.js';
import { chainHarness, setClock } from '../scheduler/helpers.js';
import { chainEvent, commitStatements, modeRow } from './helpers.js';

const ZERO32: Hex = `0x${'00'.repeat(32)}`;

describe('a reorged-out commitment (N2)', () => {
  it('is checked onchain again and resent, and its commit_tx follows the new write', async () => {
    const r = await createRound({ modes: ['free'] });
    const l = r.locked;
    const key = roundKey(l.roundId, 'free');
    const closesAtSec = l.closesAt / 1000;
    const t = l.closesAt + 5_000;
    const h = await chainHarness(t);
    setClock(t);
    // Locked onchain an hour ago, and mirrored by the indexer.
    h.fake.anchors.set(key, {
      ...h.fake.anchorOf(key),
      closesAt: BigInt(closesAtSec),
      beaconRound: BigInt(l.beaconRound),
      lockedAt: BigInt(closesAtSec - 3600),
    });
    await env.DB.prepare(
      `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash,
         log_index, event, args_json, created_at, updated_at)
       VALUES (31337, ?1, 50, ?2, 1, ?3, 0, 'Locked', ?4, 0, 0)`,
    )
      .bind(
        FAKE_ANCHOR,
        `0x${'b2'.repeat(32)}`,
        `0x${'1c'.repeat(32)}`,
        JSON.stringify({ roundKey: key, closesAt: String(closesAtSec) }),
      )
      .run();

    const item: AnchorCommitItem = {
      roundKey: key,
      roundId: l.roundId,
      mode: 'free',
      root: keccak256(stringToHex(`root ${l.roundId}`)),
      entryCount: 3,
      totalStake: '75',
      closesAtSec,
      beaconRound: l.beaconRound,
      beaconTimeSec: beaconTime(drand, l.beaconRound),
    };
    await h.anchor.submitCommit(item);
    await h.runAnchor();
    await h.runAnchor();
    const first = h.fake.sent[0]!.hash;
    expect((await modeRow(l.roundId, 'free'))?.commit_tx).toBe(first);

    // A reorg drops the commit: the indexer marks its Committed log removed.
    h.fake.anchors.set(key, {
      ...h.fake.anchorOf(key),
      committedAt: 0n,
      commitmentRoot: ZERO32,
      entryCount: 0,
      totalStake: 0n,
    });
    const removed = chainEvent(
      'anchor',
      'Committed',
      { roundKey: key, commitmentRoot: item.root, entryCount: '3', totalStake: '75' },
      { txHash: first, removed: true },
    );
    await commitStatements(await anchorConfirmationHandler(removed, env, { rpc: null as never }));
    expect((await modeRow(l.roundId, 'free'))?.commit_tx).toBeNull();

    await h.runAnchor();
    await h.runAnchor();
    expect(h.fake.sent).toHaveLength(2);
    const second = h.fake.sent[1]!.hash;
    expect((await h.anchor.status(key)).commit).toMatchObject({
      state: 'confirmed',
      txHash: second,
    });
    expect(h.fake.anchorOf(key).commitmentRoot).toBe(item.root);
    expect((await modeRow(l.roundId, 'free'))?.commit_tx).toBe(second);
  });
});
