// Route module `cards`: the share page and the card images (spec "Share cards and distribution" ›
// Share surfaces). Owner: W10-A.
//
//   GET /s/:shareId                     the share page: OG and Farcaster mini app embed tags, the
//                                       card, and "Play today's Flocked" carrying the sharer's ref
//                                       code and this share ID; a teaser links to the round only
//                                       once the mode has revealed;
//   GET /cards/:shareId/:variant.png    a player's result or teaser card;
//   GET /rounds/:id/card/:variant.png   the round card (split only), 404 until a mode reveals.
//
// Reveal gating ("API" › Reveal gating): a result card has no `share_cards` row before its mode's
// reveal, and the round card is built only from a revealed mode, so neither can exist early. Room
// rounds never get a share row (their cards are member-only); `/rounds/:id/card/*` is already behind
// `requireRoundAccess` from the rounds module, which is mounted before this one.
//
// Images come from R2 and are rendered on demand when one is missing (a cold key, a new variant, or
// a queue that has not caught up), then stored, so the next request is a read.
import {
  CardImageParamsSchema,
  gameDayOf,
  RoundCardParamsSchema,
  SharePageParamsSchema,
  cardVariantOfFile,
  type CardKind,
  type CardVariant,
  type Mode,
} from '@flocked/shared';
import { Hono } from 'hono';
import { trackShareLanding } from '../cards/analytics.js';
import { CARD_CACHE_CONTROL, renderToR2 } from '../cards/consumer.js';
import { cardKey, cardPrefix } from '../cards/keys.js';
import { appOrigin } from '../cards/purge.js';
import { sharePageHtml, type SharePageData } from '../cards/page.js';
import { metaLabel } from '../cards/model.js';
import type { Env } from '../env.js';
import type { AppEnv } from '../lib/auth-context.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { validate } from '../lib/validate.js';
import { PRIVATE_CACHE_CONTROL } from '../read/cache.js';
import { endpointsOf } from './stub.js';

const app = new Hono<AppEnv>();

/** This module's paths, from the pinned ENDPOINTS table, so they can never drift from it. */
function path(prefix: string): string {
  const ep = endpointsOf('cards').find((e) => e.path.startsWith(prefix));
  if (!ep) throw new Error(`no cards endpoint at ${prefix}`);
  return ep.path;
}

interface ShareRow {
  round_id: string;
  mode: Mode;
  user_id: string;
  kind: Exclude<CardKind, 'round'>;
}

function shareRow(env: Pick<Env, 'DB'>, shareId: string): Promise<ShareRow | null> {
  return env.DB.prepare('SELECT round_id, mode, user_id, kind FROM share_cards WHERE share_id = ?1')
    .bind(shareId)
    .first<ShareRow>();
}

/** The cache this colo keeps for public card images; `src/cards/purge.ts` empties it. */
function edgeCache(env: Pick<Env, 'ENVIRONMENT'>): Cache | null {
  if (env.ENVIRONMENT === 'local' || typeof caches === 'undefined') return null;
  return caches.default;
}

/**
 * One card image: R2 first, then a render. Returns null when the card does not exist (so the route
 * answers 404 rather than an empty PNG).
 */
async function cardImage(
  env: Env,
  target: { roundId: string; mode: Mode; kind: CardKind; userId?: string },
  variant: CardVariant,
): Promise<ReadableStream | Uint8Array | null> {
  const key = cardKey(cardPrefix(target.roundId, target.mode, target.kind, target.userId), variant);
  const stored = await env.BUCKET.get(key);
  if (stored) return stored.body;
  const keys = await renderToR2(env, target, [variant]);
  if (!keys) return null;
  log.info('card_rendered_on_demand', { ...target, variant });
  const fresh = await env.BUCKET.get(key);
  return fresh ? fresh.body : null;
}

/** A PNG response, cached at the edge unless the round is a room's. */
async function pngResponse(
  env: Env,
  url: string,
  body: ReadableStream | Uint8Array,
  membersOnly: boolean,
): Promise<Response> {
  const res = new Response(body as BodyInit, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': membersOnly ? PRIVATE_CACHE_CONTROL : CARD_CACHE_CONTROL,
    },
  });
  const cache = membersOnly ? null : edgeCache(env);
  if (cache) {
    // The body can only be read once: keep one copy for the cache and answer with the other.
    const [a, b] = res.body ? res.body.tee() : [null, null];
    const headers = res.headers;
    if (a && b) {
      await cache.put(url, new Response(a, { headers }));
      return new Response(b, { headers });
    }
  }
  return res;
}

app.get(path('/s/'), validate('param', SharePageParamsSchema), async (c) => {
  const { shareId } = c.req.valid('param');
  const row = await shareRow(c.env, shareId);
  if (!row) throw new HttpError('not_found', 'No such share');
  const round = await c.env.DB.prepare(
    `SELECT r.closes_at, q.prompt, m.revealed_at, u.handle, u.ref_code
     FROM rounds r
     JOIN questions q ON q.id = r.question_id
     JOIN round_modes m ON m.round_id = r.id AND m.mode = ?2
     LEFT JOIN users u ON u.id = ?3
     WHERE r.id = ?1 AND r.locked_at IS NOT NULL`,
  )
    .bind(row.round_id, row.mode, row.user_id)
    .first<{
      closes_at: number;
      prompt: string;
      revealed_at: number | null;
      handle: string | null;
      ref_code: string | null;
    }>();
  if (!round) throw new HttpError('not_found', 'No such share');
  const data: SharePageData = {
    shareId,
    kind: row.kind,
    mode: row.mode,
    handle: round.handle,
    meta: metaLabel(row.mode, gameDayOf(Math.floor(round.closes_at / 1000))),
    question: round.prompt,
    roundId: row.round_id,
    revealed: round.revealed_at !== null,
    ref: round.ref_code,
    origin: appOrigin(c.env),
  };
  trackShareLanding(c.env, { roundId: row.round_id, shareId, ref: round.ref_code });
  return new Response(sharePageHtml(data), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Short, so a re-rendered card and a reveal reach a shared cache quickly.
      'Cache-Control': 'public, max-age=60',
    },
  });
});

app.get(path('/cards/'), async (c) => {
  const parsed = CardImageParamsSchema.safeParse({
    shareId: c.req.param('shareId'),
    variant: c.req.param('variant'),
  });
  if (!parsed.success) throw new HttpError('not_found', 'No such card');
  const { shareId, variant } = parsed.data;
  const row = await shareRow(c.env, shareId);
  if (!row) throw new HttpError('not_found', 'No such card');
  const body = await cardImage(
    c.env,
    { roundId: row.round_id, mode: row.mode, kind: row.kind, userId: row.user_id },
    cardVariantOfFile(variant),
  );
  if (!body) throw new HttpError('not_found', 'No such card');
  return pngResponse(c.env, c.req.url, body, false);
});

app.get(path('/rounds/'), async (c) => {
  const parsed = RoundCardParamsSchema.safeParse({
    id: c.req.param('id'),
    variant: c.req.param('variant'),
  });
  if (!parsed.success) throw new HttpError('not_found', 'No such card');
  const { id, variant } = parsed.data;
  // The path names no mode, so the card is the revealed one, Free first (the client's default).
  const { results } = await c.env.DB.prepare(
    `SELECT m.mode, r.room_id FROM round_modes m JOIN rounds r ON r.id = m.round_id
     WHERE m.round_id = ?1 AND m.revealed_at IS NOT NULL AND r.locked_at IS NOT NULL
     ORDER BY m.mode = 'free' DESC`,
  )
    .bind(id)
    .all<{ mode: Mode; room_id: string | null }>();
  const row = results[0];
  if (!row) throw new HttpError('not_found', 'No such card');
  const body = await cardImage(
    c.env,
    { roundId: id, mode: row.mode, kind: 'round' },
    cardVariantOfFile(variant),
  );
  if (!body) throw new HttpError('not_found', 'No such card');
  return pngResponse(c.env, c.req.url, body, row.room_id !== null);
});

export const cards = app;
