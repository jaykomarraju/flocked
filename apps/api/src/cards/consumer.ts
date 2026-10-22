// The `cards` queue consumer (spec "Share cards and distribution" › Generation): render a card's
// variants and store them in R2, then give a player's card its `share_cards` row.
//
// Every message is idempotent. A re-render (a veto, or an account deletion) writes the same keys, so
// the share ID and the links to it never change — the row is created once and kept. A message whose
// card does not exist yet (a result before its mode's reveal) is logged and acked: the reveal
// fan-out enqueues it again, and the image routes render on demand.
//
// Registration for W10-D: `HANDLERS.cards` in src/queues/index.ts is `(body, _m, env) =>
// cardsHandler(body, env)`.
import { CARD_VARIANTS, type CardsMessage, type CardVariant } from '@flocked/shared';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { buildCardModel } from './build.js';
import { cardKey, cardPrefix } from './keys.js';
import { renderCard } from './render.js';
import { purgeCard } from './purge.js';

/** A card image's own cache lifetime at the edge: long, because a re-render purges it. */
export const CARD_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';

export type CardsConsumerEnv = Pick<
  Env,
  'DB' | 'BUCKET' | 'ENVIRONMENT' | 'APP_ORIGIN' | 'ANALYTICS'
>;

/** A share ID: 16 URL-safe characters from the Workers CSPRNG (`ShareIdSchema`). */
export function newShareId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Renders one card's variants into R2 and returns the keys it wrote. */
export async function renderToR2(
  env: CardsConsumerEnv,
  msg: Pick<CardsMessage, 'roundId' | 'mode' | 'kind' | 'userId'>,
  variants: readonly CardVariant[],
): Promise<string[] | null> {
  const model = await buildCardModel(env, {
    roundId: msg.roundId,
    mode: msg.mode,
    kind: msg.kind,
    userId: msg.userId,
  });
  if (!model) return null;
  const prefix = cardPrefix(msg.roundId, msg.mode, msg.kind, msg.userId);
  const keys: string[] = [];
  for (const variant of variants) {
    const png = await renderCard(model, variant);
    const key = cardKey(prefix, variant);
    await env.BUCKET.put(key, png, {
      httpMetadata: { contentType: 'image/png', cacheControl: CARD_CACHE_CONTROL },
    });
    keys.push(key);
  }
  return keys;
}

/**
 * Gives a player's card its `share_cards` row, and returns the share ID. The unique index on
 * (round_id, mode, user_id, kind) makes this safe to run again: a row that exists keeps its ID.
 */
export async function shareIdFor(
  env: Pick<Env, 'DB'>,
  msg: Pick<CardsMessage, 'roundId' | 'mode' | 'kind' | 'userId'>,
  now: number,
): Promise<string | null> {
  if (msg.kind === 'round' || !msg.userId) return null;
  const prefix = cardPrefix(msg.roundId, msg.mode, msg.kind, msg.userId);
  await env.DB.prepare(
    `INSERT INTO share_cards (share_id, round_id, mode, user_id, kind, r2_prefix, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING`,
  )
    .bind(newShareId(), msg.roundId, msg.mode, msg.userId, msg.kind, prefix, now)
    .run();
  const row = await env.DB.prepare(
    `SELECT share_id FROM share_cards
     WHERE round_id = ?1 AND mode = ?2 AND user_id = ?3 AND kind = ?4`,
  )
    .bind(msg.roundId, msg.mode, msg.userId, msg.kind)
    .first<{ share_id: string }>();
  return row?.share_id ?? null;
}

/** One `cards` message: render, store, record, and purge whatever the edge still holds. */
export async function cardsHandler(body: CardsMessage, env: Env): Promise<void> {
  const variants = body.variants.length ? body.variants : [...CARD_VARIANTS];
  const keys = await renderToR2(env, body, variants);
  if (!keys) {
    log.info('card_not_ready', {
      roundId: body.roundId,
      mode: body.mode,
      kind: body.kind,
      userId: body.userId,
    });
    return;
  }
  const shareId = await shareIdFor(env, body, Date.now());
  await purgeCard(env, { shareId, roundId: body.roundId, kind: body.kind, variants });
  log.info('card_rendered', {
    roundId: body.roundId,
    mode: body.mode,
    kind: body.kind,
    userId: body.userId,
    shareId,
    variants: variants.length,
  });
}
