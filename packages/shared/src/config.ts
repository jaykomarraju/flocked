// The locked round config (`rounds.config_json`), canonical JSON, and the two hashes committed onchain at
// question lock. Spec: "Data model" (`config_json`), "Settlement and payout math", "Modes: Free and Stakes",
// "Sealed picks" › Free mode specifics (the lock leaf), "Smart contract" (`RoundConfig`).
import { encodeAbiParameters, keccak256, stringToBytes, zeroAddress, type Hex } from 'viem';
import { z } from 'zod';

import { isUlid } from './ids';

// ---- Canonical JSON (RFC 8785, JCS) ----

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function jcsString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new TypeError('canonicalJson: string has a lone surrogate');
  return JSON.stringify(s);
}

function jcs(value: unknown, stack: object[]): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value); // ES Number::toString, which JCS adopts; −0 serializes as 0
    case 'string':
      return jcsString(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} (pre-stringify bigint)`);
  }
  const obj = value;
  if (stack.includes(obj)) throw new TypeError('canonicalJson: cyclic value');
  stack.push(obj);
  let out: string;
  if (Array.isArray(obj)) {
    const items: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) throw new TypeError('canonicalJson: sparse array');
      items.push(jcs(obj[i] as unknown, stack));
    }
    out = `[${items.join(',')}]`;
  } else {
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: only plain objects and arrays');
    }
    // Sort by UTF-16 code units: the default string comparison, not localeCompare.
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const members = keys.map((k) => {
      const v = (obj as Record<string, unknown>)[k];
      if (v === undefined)
        throw new TypeError(`canonicalJson: undefined at key ${JSON.stringify(k)}`);
      return `${jcsString(k)}:${jcs(v, stack)}`;
    });
    out = `{${members.join(',')}}`;
  }
  stack.pop();
  return out;
}

/**
 * RFC 8785 (JCS) canonical JSON: object keys sorted by UTF-16 code units, no whitespace, numbers in
 * ECMAScript form, strings escaped as `JSON.stringify` does. Accepts null, booleans, finite numbers, strings,
 * arrays and plain objects; throws on anything else (undefined, bigint, NaN, ±Infinity, lone surrogates,
 * cycles, class instances).
 */
export function canonicalJson(value: unknown): string {
  return jcs(value, []);
}

// ---- Locked config schema ----

const UINT32_MAX = 2 ** 32 - 1;
const UINT64_MAX = (1n << 64n) - 1n;
const BPS = 10_000;

/** Bounds the schema enforces. Stakes bounds equal FlockedEscrow's `createRound` checks. */
export const LOCKED_CONFIG_BOUNDS = {
  /** MIN_BEACON_DELAY / MAX_BEACON_DELAY, seconds (FlockedEscrow, FlockedAnchor, @flocked/tlock). */
  beaconDelay: { min: 60, max: 600 },
  free: {
    /** Points. The receipt and commitment leaf carry the stake as uint64. */
    stake: { min: 1n, max: UINT64_MAX },
    presets: { min: 1, max: 8 },
    capMultiple: { min: 1, max: 255 },
    minEntrants: { min: 1, max: UINT32_MAX },
    creatorAwardBps: { min: 0, max: BPS },
  },
  stakes: {
    /** USDC base units (6 decimals): MIN_STAKE 1 USDC, MAX_STAKE 100 USDC. */
    stake: { min: 1_000_000n, max: 100_000_000n },
    feeBps: { min: 0, max: 500 },
    creatorBps: { min: 0, max: 100 },
    capMultiple: { min: 1, max: 10 },
    minEntrants: { min: 1, max: UINT32_MAX },
  },
} as const;

const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** BigInt of a canonical decimal string, or null. (Zod runs refinements even after a failed check.) */
function decimalValue(s: unknown): bigint | null {
  return typeof s === 'string' && DECIMAL_RE.test(s) ? BigInt(s) : null;
}

function decimalAmount(min: bigint, max: bigint) {
  return z.string().superRefine((s, ctx) => {
    const v = decimalValue(s);
    if (v === null) {
      ctx.addIssue({ code: 'custom', message: 'must be a canonical decimal integer string' });
    } else if (v < min || v > max) {
      ctx.addIssue({ code: 'custom', message: `must be in [${min}, ${max}]` });
    }
  });
}

function intIn(b: { min: number; max: number }) {
  return z.int().min(b.min).max(b.max);
}

// Lowercase, like every address on the wire (`wire.ts`), so a config has one spelling.
const LowercaseAddress = z.string().superRefine((a, ctx) => {
  if (!ADDRESS_RE.test(a)) {
    ctx.addIssue({ code: 'custom', message: 'must be a lowercase 0x-prefixed 20-byte address' });
  } else if (a === zeroAddress) {
    ctx.addIssue({ code: 'custom', message: 'must not be the zero address' });
  }
});

const F = LOCKED_CONFIG_BOUNDS.free;
const S = LOCKED_CONFIG_BOUNDS.stakes;

/**
 * Free mode: points stake range and selector presets, the settlement parameters (fees are always 0 in
 * Free), and the house-minted creator award ⌊Lp · creatorAwardBps / 10000⌋ to `awardRecipient` (the
 * author's user ID; null for house questions and rooms, which pay no award).
 */
export const FreeLockedConfigSchema = z
  .strictObject({
    stakeMin: decimalAmount(F.stake.min, F.stake.max),
    stakeMax: decimalAmount(F.stake.min, F.stake.max),
    presets: z.array(decimalAmount(F.stake.min, F.stake.max)).min(F.presets.min).max(F.presets.max),
    feeBps: z.literal(0),
    creatorBps: z.literal(0),
    capMultiple: intIn(F.capMultiple),
    minEntrants: intIn(F.minEntrants),
    creatorAwardBps: intIn(F.creatorAwardBps),
    awardRecipient: z.string().refine(isUlid, 'must be a ULID').nullable(),
  })
  .superRefine((c, ctx) => {
    const min = decimalValue(c.stakeMin);
    const max = decimalValue(c.stakeMax);
    if (min === null || max === null || !Array.isArray(c.presets)) return; // already reported
    if (min > max)
      ctx.addIssue({ code: 'custom', message: 'stakeMin > stakeMax', path: ['stakeMax'] });
    let prev = -1n;
    c.presets.forEach((p, i) => {
      const v = decimalValue(p);
      if (v === null) return;
      if (v < min || v > max) {
        ctx.addIssue({
          code: 'custom',
          message: 'preset outside the stake range',
          path: ['presets', i],
        });
      }
      if (v <= prev) {
        ctx.addIssue({
          code: 'custom',
          message: 'presets must be strictly ascending',
          path: ['presets', i],
        });
      }
      prev = v;
    });
  });

/** Stakes mode: exactly the `RoundConfig` money fields, within FlockedEscrow's bounds. */
export const StakesLockedConfigSchema = z.strictObject({
  /** Fixed stake in USDC base units. */
  stake: decimalAmount(S.stake.min, S.stake.max),
  feeBps: intIn(S.feeBps),
  creatorBps: intIn(S.creatorBps),
  capMultiple: intIn(S.capMultiple),
  minEntrants: intIn(S.minEntrants),
  /** The resolved creator address: the author's payout wallet, or the treasury. */
  creator: LowercaseAddress,
});

/**
 * `rounds.config_json`, frozen at question lock. `beaconDelay` (seconds) is per round; each enabled mode
 * has its own section and a disabled mode is absent. Money is a decimal string; bps and counts are integers.
 */
export const LockedConfigSchema = z
  .strictObject({
    beaconDelay: intIn(LOCKED_CONFIG_BOUNDS.beaconDelay),
    free: FreeLockedConfigSchema.optional(),
    stakes: StakesLockedConfigSchema.optional(),
  })
  .refine(
    (c) => c.free !== undefined || c.stakes !== undefined,
    'at least one mode must be enabled',
  );

export type LockedConfig = z.infer<typeof LockedConfigSchema>;
export type FreeLockedConfig = z.infer<typeof FreeLockedConfigSchema>;
export type StakesLockedConfig = z.infer<typeof StakesLockedConfigSchema>;

/**
 * Launch defaults for a daily round (spec: "Modes: Free and Stakes", "Settlement and payout math",
 * "Round lifecycle" › Timing). Rooms differ: Stakes rooms use minEntrants 3 and rooms pay no creator award.
 * Clients flag any locked value that differs. The Free presets are not in the spec.
 */
export const LOCKED_CONFIG_DEFAULTS = {
  beaconDelay: 120,
  free: {
    stakeMin: '10',
    stakeMax: '100',
    presets: ['10', '25', '50', '100'],
    feeBps: 0,
    creatorBps: 0,
    capMultiple: 10,
    minEntrants: 1,
    creatorAwardBps: 100,
  },
  stakes: {
    stake: '5000000',
    feeBps: 500,
    creatorBps: 100,
    capMultiple: 10,
    minEntrants: 20,
  },
} as const;

// ---- Hashes committed at lock ----

/**
 * The canonical JSON the Free config hash covers: `{"beaconDelay":…,"free":{…}}` from the parsed locked
 * config (stake range, presets, fees, cap, minEntrants, creator award and recipient, and beaconDelay).
 * Throws if the config is invalid or has no Free mode.
 */
export function freeConfigCanonicalJson(cfg: z.input<typeof LockedConfigSchema>): string {
  const c = LockedConfigSchema.parse(cfg);
  if (!c.free) throw new RangeError('the locked config has no Free mode');
  return canonicalJson({ beaconDelay: c.beaconDelay, free: c.free });
}

/** The lock leaf's `configHash`: keccak256 of the UTF-8 bytes of `freeConfigCanonicalJson(cfg)`. */
export function freeConfigHash(cfg: z.input<typeof LockedConfigSchema>): Hex {
  return keccak256(stringToBytes(freeConfigCanonicalJson(cfg)));
}

/** What `questionHash` covers: the prompt and both options (`questions.options_json`). */
export interface QuestionHashInput {
  prompt: string;
  options: readonly [QuestionHashOption, QuestionHashOption];
}
export interface QuestionHashOption {
  label: string;
  emoji?: string | null;
}

function normalizeText(s: string): string {
  return s.normalize('NFC').trim();
}

/**
 * `questionHash` (`RoundConfig.questionHash`, the Free lock leaf) =
 * keccak256(abi.encode(string prompt, string label0, string emoji0, string label1, string emoji1)), each
 * string NFC-normalized then trimmed, `""` for no emoji. Throws on an empty prompt or label.
 */
export function questionHash(q: QuestionHashInput): Hex {
  if (q.options.length !== 2) throw new RangeError('a question has exactly two options');
  const prompt = normalizeText(q.prompt);
  const [a, b] = q.options;
  const label0 = normalizeText(a.label);
  const label1 = normalizeText(b.label);
  if (!prompt || !label0 || !label1) throw new RangeError('prompt and labels must not be empty');
  const emoji0 = normalizeText(a.emoji ?? '');
  const emoji1 = normalizeText(b.emoji ?? '');
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
      ],
      [prompt, label0, emoji0, label1, emoji1],
    ),
  );
}
