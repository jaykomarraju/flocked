// The Flocked API as the watcher reads it: public routes only, parsed against the watcher's own
// schemas. Nothing here imports @flocked/shared, so a change the backend makes to its wire types
// cannot quietly change what the watcher believes a round was.
//
// The schemas are loose on purpose: a field the watcher does not read may appear or change without
// stopping verification, but every field it does read is checked.
import { z } from 'zod';

const Decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Seconds = z.number().int().nonnegative();

/** `StakesConfigWire`: every `RoundConfig` field as published at lock, plus the author's payout. */
export const PublishedStakesConfigSchema = z.looseObject({
  chainRoundId: Decimal,
  opensAt: Seconds,
  closesAt: Seconds,
  beaconRound: z.number().int().positive(),
  stake: Decimal,
  feeBps: z.number().int().nonnegative(),
  creatorBps: z.number().int().nonnegative(),
  capMultiple: z.number().int().positive(),
  minEntrants: z.number().int().positive(),
  creator: Address,
  questionHash: Hash,
  authorHandle: z.string().nullable(),
  payoutAddress: Address.nullable(),
});
export type PublishedStakesConfig = z.infer<typeof PublishedStakesConfigSchema>;

/** One published value that differs from the launch defaults, with the audit row that set it. */
export const PublishedOverrideSchema = z.looseObject({
  field: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  auditId: z.string().min(1),
});
export type PublishedOverride = z.infer<typeof PublishedOverrideSchema>;

/** `RoundConfigWire`: the config frozen at question lock, as `/rounds/:id` publishes it. */
export const PublishedConfigSchema = z.looseObject({
  beaconDelay: z.number().int().positive(),
  stakes: PublishedStakesConfigSchema.optional(),
  overrides: z.array(PublishedOverrideSchema),
});
export type PublishedConfig = z.infer<typeof PublishedConfigSchema>;

export const PublishedRoundSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(['daily', 'room']),
  roomId: z.string().nullable(),
  gameDay: z.string().min(1),
  question: z.looseObject({ author: z.unknown().nullable() }),
  opensAt: Seconds,
  closesAt: Seconds,
  beaconRound: z.number().int().positive(),
  config: PublishedConfigSchema.nullable(),
  modes: z.looseObject({ stakes: z.looseObject({}).optional() }),
});
export type PublishedRound = z.infer<typeof PublishedRoundSchema>;

const TodaySchema = z.looseObject({
  round: PublishedRoundSchema.nullable(),
  previousRoundId: z.string().nullable(),
});
const DetailSchema = z.looseObject({ round: PublishedRoundSchema });
const ArchiveSchema = z.looseObject({
  rounds: z.array(z.looseObject({ id: z.string().min(1) })),
});

/** How long the watcher waits on one public API read before giving up on this tick. */
export const API_TIMEOUT_MS = 10_000;

export class ApiError extends Error {}

export interface ApiClient {
  today(): Promise<{ round: PublishedRound | null; previousRoundId: string | null }>;
  round(id: string): Promise<PublishedRound | null>;
  recentRoundIds(limit: number): Promise<string[]>;
}

async function getJson(
  base: string,
  path: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const url = `${base.replace(/\/+$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ApiError(`GET ${path}: ${(e as Error).message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(`GET ${path}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new ApiError(`GET ${path}: ${(e as Error).message}`);
  }
}

function parse<T>(path: string, schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(`GET ${path}: ${r.error.issues[0]?.message ?? 'bad body'}`);
  return r.data;
}

/** Reads the public API at `baseUrl` (origin plus `/api/v1`). */
export function apiClient(
  baseUrl: string,
  o: { fetch?: typeof fetch; timeoutMs?: number } = {},
): ApiClient {
  const get = o.fetch ?? fetch;
  const ms = o.timeoutMs ?? API_TIMEOUT_MS;
  return {
    async today() {
      const body = await getJson(baseUrl, '/rounds/today', get, ms);
      if (body === null) return { round: null, previousRoundId: null };
      const t = parse('/rounds/today', TodaySchema, body);
      return { round: t.round, previousRoundId: t.previousRoundId };
    },
    async round(id) {
      const body = await getJson(baseUrl, `/rounds/${encodeURIComponent(id)}`, get, ms);
      if (body === null) return null;
      return parse(`/rounds/${id}`, DetailSchema, body).round;
    },
    async recentRoundIds(limit) {
      const body = await getJson(baseUrl, `/rounds?limit=${limit}`, get, ms);
      if (body === null) return [];
      return parse('/rounds', ArchiveSchema, body).rounds.map((r) => r.id);
    },
  };
}
