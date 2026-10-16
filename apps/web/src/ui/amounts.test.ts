import { describe, expect, it } from 'vitest';
import { formatAmount, formatUsdc, groupDigits } from './amounts';

describe('amounts', () => {
  it('groups digits in threes', () => {
    expect(groupDigits(0n)).toBe('0');
    expect(groupDigits(999)).toBe('999');
    expect(groupDigits(1204)).toBe('1,204');
    expect(groupDigits(1_234_567n)).toBe('1,234,567');
    expect(groupDigits(-30_100n)).toBe('-30,100');
  });

  it('shows whole USDC without decimals and cents with two', () => {
    expect(formatUsdc(5_000_000n)).toBe('5');
    expect(formatUsdc(1_060_000_000n)).toBe('1,060');
    expect(formatUsdc(2_500_000n)).toBe('2.50');
    expect(formatUsdc(17_670_000n)).toBe('17.67');
    expect(formatUsdc(0n)).toBe('0');
  });

  it('rounds sub-cent USDC down', () => {
    expect(formatUsdc(17_679_999n)).toBe('17.67');
    expect(formatUsdc(1n)).toBe('0.00');
  });

  it('adds the mode unit', () => {
    expect(formatAmount(30_100n, 'free')).toBe('30,100 points');
    expect(formatAmount(5_000_000n, 'stakes')).toBe('5 USDC');
  });
});
