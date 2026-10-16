// Amount text for the round-status and stake components. Wire amounts are decimal integer strings
// (`DecimalBigintSchema`): points in Free, USDC base units (6 decimals) in Stakes. Whole USDC shows no
// decimals and an amount with cents shows two (Paper Components › Stake selector: "5 USDC",
// "2.50 USDC"); sub-cent dust rounds down, so the UI never shows more than is there.

const USDC_UNIT = 1_000_000n;
const CENT = 10_000n;

/** Digits with en-US thousands separators: 30100n → "30,100". */
export function groupDigits(value: bigint | number): string {
  const n = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/** A USDC amount in base units as text, without the unit: 5_000_000n → "5", 2_500_000n → "2.50". */
export function formatUsdc(baseUnits: bigint): string {
  if (baseUnits < 0n) return `-${formatUsdc(-baseUnits)}`;
  const whole = baseUnits / USDC_UNIT;
  const cents = (baseUnits % USDC_UNIT) / CENT;
  if (baseUnits % USDC_UNIT === 0n) return groupDigits(whole);
  return `${groupDigits(whole)}.${cents.toString().padStart(2, '0')}`;
}

/** An amount with its unit: Free counts points, Stakes counts USDC (base units). */
export function formatAmount(value: bigint, mode: 'free' | 'stakes'): string {
  return mode === 'free' ? `${groupDigits(value)} points` : `${formatUsdc(value)} USDC`;
}
