// W7-F1 R17: settlementHold (src/indexer/holds.ts) reads every reason the settlement_holds CHECK
// allows, and only a foreign_entry hold carries a tx_hash (spec "Data model"). The typed literals
// below are what `tsc` checks (the api typecheck covers tests): under a `HoldReason` of
// 'foreign_entry' only, or a non-null `txHash`, this file doesn't compile.
import { env } from 'cloudflare:test';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { settlementHold, type HoldReason, type SettlementHold } from '../../src/indexer/holds.js';

const REASONS: readonly HoldReason[] = ['foreign_entry', 'void_rate', 'refund_vetoed'];
const TX: Hex = `0x${'fe'.repeat(32)}`;

async function hold(roundId: string, mode: string, reason: HoldReason, txHash: Hex | null) {
  await env.DB.prepare(
    'INSERT INTO settlement_holds (round_id, mode, reason, tx_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(roundId, mode, reason, txHash, REASONS.indexOf(reason) + 1)
    .run();
}

describe('W7-F1 R17: settlementHold types every hold reason', () => {
  it('a void_rate and a refund_vetoed hold read with their reason and a null txHash; a foreign_entry hold with its transaction', async () => {
    await hold('r17-void', 'free', 'void_rate', null);
    await hold('r17-veto', 'stakes', 'refund_vetoed', null);
    await hold('r17-foreign', 'stakes', 'foreign_entry', TX);

    const voidRate: SettlementHold = {
      roundId: 'r17-void',
      mode: 'free',
      reason: 'void_rate',
      txHash: null,
      createdAt: 2,
    };
    const vetoed: SettlementHold = {
      roundId: 'r17-veto',
      mode: 'stakes',
      reason: 'refund_vetoed',
      txHash: null,
      createdAt: 3,
    };
    const foreign: SettlementHold = {
      roundId: 'r17-foreign',
      mode: 'stakes',
      reason: 'foreign_entry',
      txHash: TX,
      createdAt: 1,
    };
    expect(await settlementHold(env.DB, 'r17-void', 'free')).toEqual(voidRate);
    expect(await settlementHold(env.DB, 'r17-veto', 'stakes')).toEqual(vetoed);
    expect(await settlementHold(env.DB, 'r17-foreign', 'stakes')).toEqual(foreign);
    expect(await settlementHold(env.DB, 'r17-void', 'stakes')).toBeNull();
  });
});
