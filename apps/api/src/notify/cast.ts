// The daily official cast (spec "Share cards and distribution" › Distribution hooks): at opensAt, the
// official account casts the question with the round as a mini app embed. Daily rounds only. It is
// posted once per round: `notification_log` holds `daily_cast:{roundId}` (no user), and the cast API
// gets the same key as its idempotency key, so an alarm that fires twice casts once.
//
// The signer is the owner's (OA-11): Neynar's cast API (`POST /v2/farcaster/cast`, `x-api-key`, a
// managed signer's UUID). Without NEYNAR_API_KEY and FARCASTER_CAST_SIGNER_UUID nothing is cast (logged);
// locally FARCASTER_CAST_API_URL points it at the e2e mock (honoured only when ENVIRONMENT is 'local').
// A failed cast is logged and its key released, never thrown: it must not hold up `question_live`.
import type { Env } from '../env.js';
import { now as clockNow } from '../lib/clock.js';
import { log } from '../lib/log.js';
import type { HookRound } from '../rounds/hooks.js';
import { claimKey, finishKey, releaseKey } from './dedupe.js';
import { DEFAULT_ORIGIN, clip } from './render.js';

/** Vars the cast reads that src/env.ts doesn't declare yet ("Notes for D"). */
export type CastVars = {
  /** Neynar API key (a secret). */
  NEYNAR_API_KEY?: string;
  /** The official account's Neynar managed signer UUID (a secret). */
  FARCASTER_CAST_SIGNER_UUID?: string;
  /** Cast API origin override (e2e/mocks/farcaster-notify); honoured only when ENVIRONMENT is 'local'. */
  FARCASTER_CAST_API_URL?: string;
};

export const NEYNAR_API_ORIGIN = 'https://api.neynar.com';

/** Casts are capped at 320 bytes; a question is at most 120 characters, so this never cuts in practice. */
const CAST_TEXT_MAX = 300;

export interface CastPoster {
  post(cast: { text: string; embedUrl: string; idem: string }): Promise<void>;
}

/** Neynar's cast API, or null when the deployment has no signer. */
export function neynarPoster(
  env: Pick<Env, 'ENVIRONMENT'> & CastVars,
  fetchFn: typeof fetch = fetch,
): CastPoster | null {
  const key = env.NEYNAR_API_KEY;
  const signer = env.FARCASTER_CAST_SIGNER_UUID;
  if (!key || !signer) return null;
  const origin =
    (env.ENVIRONMENT === 'local' ? env.FARCASTER_CAST_API_URL : undefined) ?? NEYNAR_API_ORIGIN;
  return {
    async post({ text, embedUrl, idem }) {
      const res = await fetchFn(new URL('/v2/farcaster/cast', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ signer_uuid: signer, text, embeds: [{ url: embedUrl }], idem }),
      });
      if (!res.ok) throw new Error(`cast API answered ${res.status}`);
    },
  };
}

export type CastResult = 'posted' | 'already' | 'skipped' | 'failed';

/** Posts the daily cast for `round` once. */
export async function postDailyCast(
  env: Pick<Env, 'DB' | 'ENVIRONMENT' | 'APP_ORIGIN' | 'FLOCKED_TEST_CLOCK'> & CastVars,
  round: HookRound,
  poster: CastPoster | null = neynarPoster(env),
): Promise<CastResult> {
  if (round.kind !== 'daily') return 'skipped';
  if (!poster) {
    log.info('daily_cast_unconfigured', { roundId: round.roundId });
    return 'skipped';
  }
  const db = env.DB;
  const key = `daily_cast:${round.roundId}`;
  const t = clockNow(env);
  const claim = await claimKey(db, { key, userId: null, event: 'daily_cast', source: key }, t);
  if (claim.kind !== 'claimed') return 'already';
  const { lease } = claim;
  try {
    const row = await db
      .prepare(
        'SELECT q.prompt FROM rounds r JOIN questions q ON q.id = r.question_id WHERE r.id = ?1',
      )
      .bind(round.roundId)
      .first<{ prompt: string }>();
    if (!row) throw new Error('round has no question');
    const embedUrl = new URL(`/r/${round.roundId}`, env.APP_ORIGIN ?? DEFAULT_ORIGIN).toString();
    await poster.post({ text: clip(row.prompt, CAST_TEXT_MAX), embedUrl, idem: key });
    await finishKey(db, key, t, lease);
    log.info('daily_cast_posted', { roundId: round.roundId });
    return 'posted';
  } catch (err) {
    await releaseKey(db, key, lease).catch(() => undefined);
    log.error('daily_cast_failed', {
      roundId: round.roundId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}
