// The bundle as docs/bundle-format.md (bundleFormat 1) pins it: object keys, the manifest and chunk
// shapes, and the canonical encoding. Parsing is strict, so a field the format doesn't have is a
// mismatch rather than something silently ignored.
import { VOID_REASONS, type Mode } from '@flocked/settle';
import { canonicalJson } from '@flocked/shared';
import { z } from 'zod';

export const BUNDLE_FORMAT = 1;

export function bundlePrefix(roundId: string, mode: Mode): string {
  return `bundles/${roundId}/${mode}`;
}

export function manifestKey(roundId: string, mode: Mode): string {
  return `${bundlePrefix(roundId, mode)}/manifest.json`;
}

export function chunkKey(roundId: string, mode: Mode, index: number): string {
  return `${bundlePrefix(roundId, mode)}/chunk-${String(index).padStart(4, '0')}.json`;
}

const hex = (bytes?: number) =>
  z
    .string()
    .regex(bytes === undefined ? /^0x[0-9a-f]*$/ : new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`));
const Hash = hex(32);
const Decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Count = z.number().int().nonnegative();
const Option = z.union([z.literal(0), z.literal(1)]);
const VoidReasonSchema = z.enum(VOID_REASONS);

const RecordSchema = z.strictObject({
  outcome: z.enum(['settled', 'refunded']),
  refundReason: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  n: z.tuple([Decimal, Decimal]),
  w: z.tuple([Decimal, Decimal]),
  winner: Option.nullable(),
  lossPool: Decimal,
  fee: Decimal,
  creatorFee: Decimal,
  distributable: Decimal,
  rebatePool: Decimal,
  dust: Decimal,
  voidCount: Decimal,
  voidStake: Decimal,
  total: Decimal,
  creatorAward: Decimal,
});
export type RecordJson = z.infer<typeof RecordSchema>;

const Totals = z.strictObject({ n: Decimal, w: Decimal });

export const ChunkRefSchema = z.strictObject({
  index: Count,
  key: z.string(),
  hash: Hash,
  entries: Count,
  firstSeq: Count,
  lastSeq: Count,
  totals: z.tuple([Totals, Totals]),
  voids: Count,
});
export type ChunkRef = z.infer<typeof ChunkRefSchema>;

export const ManifestSchema = z.strictObject({
  bundleFormat: z.literal(BUNDLE_FORMAT),
  formulaVersion: Count,
  roundId: z.string(),
  mode: z.enum(['free', 'stakes']),
  kind: z.enum(['daily', 'room']),
  roomId: z.string().nullable(),
  closesAt: Count,
  beaconRound: Count,
  config: z.unknown(),
  drand: z.strictObject({
    chainHash: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().regex(/^[0-9a-f]+$/),
  }),
  commitment: z.strictObject({ root: Hash, anchorTx: Hash, entryCount: Count }).nullable(),
  chainRoundId: Decimal.nullable(),
  closeBlock: z.strictObject({ number: Count, hash: Hash }).nullable(),
  record: RecordSchema,
  voids: z.partialRecord(VoidReasonSchema, Count),
  payoutRoot: Hash.nullable(),
  entryCount: Count,
  chunkSize: z.number().int().positive(),
  chunks: z.array(ChunkRefSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const BundleEntrySchema = z.strictObject({
  seq: Count,
  account: z.string(),
  stake: Decimal,
  option: Option.nullable(),
  nonce: hex(16).nullable(),
  valid: z.boolean(),
  voidReason: VoidReasonSchema.nullable(),
  commitment: Hash.optional(),
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9_-]*$/)
    .nullable()
    .optional(),
  qualifies: z.boolean().optional(),
});
export type BundleEntry = z.infer<typeof BundleEntrySchema>;

export const ChunkSchema = z.strictObject({
  bundleFormat: z.literal(BUNDLE_FORMAT),
  roundId: z.string(),
  mode: z.enum(['free', 'stakes']),
  index: Count,
  entries: z.array(BundleEntrySchema),
});
export type Chunk = z.infer<typeof ChunkSchema>;

const utf8 = new TextEncoder();

/** The canonical (RFC 8785) bytes of a value, as the settlement writes every bundle object. */
export function canonicalBytes(value: unknown): Uint8Array {
  return utf8.encode(canonicalJson(value));
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parses an object's bytes against `schema` and checks they are the canonical encoding of what they
 * hold (no extra whitespace, sorted keys), so equal values always mean equal hashes.
 */
export function parseCanonical<T>(bytes: Uint8Array, schema: z.ZodType<T>): Parsed<T> {
  let json: unknown;
  try {
    // `ignoreBOM` is spelled out because @cloudflare/workers-types requires both options: without
    // it this file does not typecheck in a Worker that imports the library (apps/watcher, W10-B).
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (e) {
    return { ok: false, error: `not UTF-8 JSON: ${(e as Error).message}` };
  }
  const r = schema.safeParse(json);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error).replace(/\n/g, '; ') };
  if (!sameBytes(canonicalBytes(json), bytes)) {
    return { ok: false, error: 'not the canonical (RFC 8785) encoding of its value' };
  }
  return { ok: true, value: r.data };
}
