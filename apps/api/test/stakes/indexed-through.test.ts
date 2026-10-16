// W7-F1 R18 (owner decision C4): "processed past its expiry" (spec "Identity and personhood" ›
// Entry tickets (Stakes)) is judged by the block timestamp of the indexer's position,
// `indexer_state.last_block_timestamp` (migration 0020), still held to a second before the oldest
// mirrored event not yet handed to its handlers (src/stakes/cap.ts indexedThroughSec).
import { env } from 'cloudflare:test';
import type { StakesPrepareResponse } from '@flocked/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deploymentOf } from '../../src/chain/client.js';
import { indexedThroughSec } from '../../src/stakes/cap.js';
import { seedFixture } from '../helpers/index.js';
import {
  clockAt,
  codeOf,
  player,
  prepare,
  round,
  setStakesConfig,
  stakesTest,
  type StakesTest,
} from './helpers.js';

const S = 1_900_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** The indexer's position for (chainId, escrow): `block`, stamped `timestamp` (null: before 0020). */
async function position(chainId: number, escrow: string, block: number, timestamp: number | null) {
  await env.DB.prepare(
    `INSERT INTO indexer_state (chain_id, contract, last_block_number, last_block_hash,
       last_block_timestamp, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0)
     ON CONFLICT (chain_id, contract) DO UPDATE SET last_block_number = excluded.last_block_number,
       last_block_hash = excluded.last_block_hash,
       last_block_timestamp = excluded.last_block_timestamp`,
  )
    .bind(chainId, escrow, block, hash(block), timestamp)
    .run();
}

let tx = 0;
/** A mirrored escrow event in `block`, stamped `sec`; `pending`: not yet handed to its handlers. */
async function event(chainId: number, escrow: string, block: number, sec: number, pending = false) {
  await env.DB.prepare(
    `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash,
       log_index, event, args_json, removed, revision, dispatched_revision, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'RoundCreated', '{}', 0, 0, ?7, 0, 0)`,
  )
    .bind(chainId, escrow, block, hash(block), sec, hash(10_000_000 + ++tx), pending ? null : 0)
    .run();
}

describe('W7-F1 R18: indexedThroughSec reads the position’s block timestamp', () => {
  const escrow = `0x${'e5'.repeat(20)}`;
  let chainId = 700_000;
  beforeEach(() => {
    chainId += 1;
  });

  it('is the position’s timestamp, not a bound from the newest escrow event below it', async () => {
    // 100 blocks after the last escrow event, at Base's 2 s: the old bound said S + 100.
    await event(chainId, escrow, 1_000, S);
    await position(chainId, escrow, 1_100, S + 200);
    expect(await indexedThroughSec(env.DB, chainId, escrow)).toBe(S + 200);
  });

  it('is known with no escrow event mirrored yet', async () => {
    await position(chainId, escrow, 1_100, S);
    expect(await indexedThroughSec(env.DB, chainId, escrow)).toBe(S);
  });

  it('is held to a second before the oldest event not yet handed to its handlers', async () => {
    await event(chainId, escrow, 1_000, S);
    await event(chainId, escrow, 1_050, S + 100, true);
    await position(chainId, escrow, 1_100, S + 200);
    expect(await indexedThroughSec(env.DB, chainId, escrow)).toBe(S + 99);
  });

  it('a position stored before 0020 (no timestamp) keeps the W6-F1 bound, and null with no event', async () => {
    await position(chainId, escrow, 1_100, null);
    expect(await indexedThroughSec(env.DB, chainId, escrow)).toBeNull();
    await event(chainId, escrow, 1_000, S);
    expect(await indexedThroughSec(env.DB, chainId, escrow)).toBe(S + 100);
    expect(await indexedThroughSec(env.DB, chainId + 1_000, escrow)).toBeNull();
  });
});

describe('W7-F1 R18: the daily cap through /prepare', () => {
  let t: StakesTest;
  beforeAll(async () => {
    await seedFixture(env.DB);
  });
  beforeEach(async () => {
    await setStakesConfig({});
    t = stakesTest();
  });

  it('an unused ticket stops counting once the position is stamped past its expiry, however long ago the last escrow event was', async () => {
    const [a, b] = [await round(t), await round(t)];
    const p = await player(t);
    await env.DB.prepare('INSERT INTO limits (user_id, daily_stake_cap) VALUES (?1, ?2)')
      .bind(p.id, 5_000_000)
      .run();
    const res = await prepare(t, p, a.locked.roundId, p.wallet);
    expect(res.status).toBe(200);
    const { expiry } = (await res.json<StakesPrepareResponse>()).ticket;
    clockAt(t, (expiry + 120) * 1000);
    const capped = async () => codeOf(await prepare(t, p, b.locked.roundId, p.wallet));
    const chainId = Number(env.CHAIN_ID);
    const escrow = deploymentOf(env).escrow.toLowerCase();

    // The last escrow event 300 s before expiry, 150 blocks back: one second per block would
    // put the position 150 s before expiry. Its block is stamped at expiry: not past it yet.
    await event(chainId, escrow, 5_000, expiry - 300);
    await position(chainId, escrow, 5_150, expiry);
    expect(await capped()).toBe('stake_cap_reached');
    // Stamped a second past expiry: processed past it, so the unused ticket no longer counts.
    await position(chainId, escrow, 5_151, expiry + 1);
    const next = await prepare(t, p, b.locked.roundId, p.wallet);
    expect(next.status, await next.clone().text()).toBe(200);
  });
});
