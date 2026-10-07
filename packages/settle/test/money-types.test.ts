import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EntryInput, Payout, SettlementRecord, StakesClosedForm } from '../src/index.js';

type MoneyKeys = Exclude<keyof SettlementRecord, 'outcome' | 'refundReason' | 'winner' | 'n' | 'w'>;

// The only `number` uses allowed in src/: params (bps, cap, counts), Merkle encodings, comparators.
const ALLOWED_NUMBER_LINES = new Set([
  'feeBps: number;',
  'creatorBps: number;',
  'capMultiple: number;',
  'minEntrants: number;',
  'creatorAwardBps?: number;',
  'seq: number;',
  'export type VoidReason = (typeof VOID_REASONS)[number];',
  'const KIND_ORDER: Record<PayoutKind, number> = { win: 0, rebate: 1, void_refund: 2, refund: 3 };',
  'export function comparePayouts(a: Payout, b: Payout): number {',
  'function count(name: string, value: number, min: number, max: number): bigint {',
  'const k: number = kind; // runtime check for untyped callers',
  'const mode: number = l.mode; // runtime check for untyped callers',
  'const values = leaves.map(({ account, kind }): [bigint, Hex, number] => {',
  'export function freeCommitmentTree(leaves: FreeCommitmentLeaf[]): PayoutTree<[seq: number]> {',
  'const values = leaves.map((l): [Hex, number, Hex, bigint, Hex, number] => {',
  'const index = new Map<string, number>();',
]);

/** Lines in src/*.ts that use floating-point helpers or declare `number` outside the allowlist. */
function numberOffenders(dir: string): string[] {
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const where = `${file}:${i + 1}: ${line.trim()}`;
        const comment = /^\s*(\/\/|\/?\*)/.test(line);
        if (/\bMath\.|\bparseFloat\b|\bparseInt\b|\bNumber\(|\btoFixed\(|\b\d+\.\d+\b/.test(line)) offenders.push(where);
        else if (!comment && /\bnumber\b/.test(line) && !ALLOWED_NUMBER_LINES.has(line.trim())) offenders.push(where);
      });
  }
  return offenders;
}

describe('money is bigint only', () => {
  it('type level: every money field is bigint', () => {
    expectTypeOf<EntryInput['stake']>().toEqualTypeOf<bigint>();
    expectTypeOf<Payout['amount']>().toEqualTypeOf<bigint>();
    expectTypeOf<SettlementRecord[MoneyKeys]>().toEqualTypeOf<bigint>();
    expectTypeOf<SettlementRecord['w']>().toEqualTypeOf<[bigint, bigint]>();
    expectTypeOf<StakesClosedForm[Exclude<keyof StakesClosedForm, 'outcome' | 'refundReason' | 'winner'>]>().toEqualTypeOf<bigint>();
  });

  it('grep: src/ has no floating-point helpers and uses number only on the allowlist', () => {
    expect(numberOffenders(join(import.meta.dirname, '../src'))).toEqual([]);
  });
});
