// Dropping a card's cached images after a re-render (spec "Share cards and distribution" ›
// Generation: "After a veto, cards are re-rendered at the same keys and the edge cache purged").
//
// A Worker can delete what its own colo holds, through the Cache API, which is what the image routes
// fill (`caches.default`). Other colos keep their copy until `max-age` runs out, so a card's images
// are stored with an hour of browser freshness and a day at the edge; purging every colo needs the
// zone's purge API and a token the Worker does not have (W10-A handoff, "Notes for D and Z").
import { CARD_VARIANTS, type CardKind, type CardVariant } from '@flocked/shared';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { cardImagePath, roundCardPath } from './keys.js';

export type PurgeEnv = Pick<Env, 'ENVIRONMENT' | 'APP_ORIGIN'>;

/** The origin links and cache keys are built on (the same default as notification links). */
export const DEFAULT_ORIGIN = 'https://flocked.xyz';

export function appOrigin(env: Pick<Env, 'APP_ORIGIN'>): string {
  return env.APP_ORIGIN ?? DEFAULT_ORIGIN;
}

export interface PurgeTarget {
  shareId: string | null;
  roundId: string;
  kind: CardKind;
  variants?: readonly CardVariant[];
}

/** The URLs a card is served at, which are also its cache keys. */
export function cardUrls(env: Pick<Env, 'APP_ORIGIN'>, t: PurgeTarget): string[] {
  const origin = appOrigin(env);
  const variants = t.variants ?? CARD_VARIANTS;
  const paths =
    t.kind === 'round'
      ? variants.map((v) => roundCardPath(t.roundId, v))
      : t.shareId
        ? variants.map((v) => cardImagePath(t.shareId as string, v))
        : [];
  return paths.map((p) => `${origin}${p}`);
}

/** Deletes this colo's cached copies. Never throws: a stale image must not fail a render. */
export async function purgeCard(env: PurgeEnv, t: PurgeTarget): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  let purged = 0;
  for (const url of cardUrls(env, t)) {
    try {
      if (await caches.default.delete(url)) purged++;
    } catch (err) {
      log.error('card_purge_failed', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return purged;
}
