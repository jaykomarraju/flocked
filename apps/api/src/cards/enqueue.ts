// Enqueuing card renders. The reveal fan-out is the main one (spec "Share cards and distribution" ›
// Generation: every card for a round rendered within five minutes of the reveal), and it runs where
// the outcome became durable: `onModeFinal` for Free (apply or refund) and for a Stakes mode that
// finalised without a proposal, and the Stakes proposal handler at the reveal itself.
//
// Daily rounds only. A room round's cards are member-only on every route (spec "API" › Reveal
// gating), so they are never given a public share page or pre-rendered; `/rounds/:id/card/*.png`
// renders one on demand behind `requireRoundAccess` (W10-A handoff, "Spec issues").
import { CARD_VARIANTS, type CardsMessage, type Mode } from '@flocked/shared';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import type { ModeFinalHandler } from '../settlement/hooks.js';

/** `sendBatch` takes at most 100 messages. */
const SEND_BATCH_MAX = 100;

export type CardsQueueEnv = Pick<Env, 'DB' | 'QUEUE_CARDS'>;

async function send(env: CardsQueueEnv, messages: readonly CardsMessage[]): Promise<number> {
  for (let i = 0; i < messages.length; i += SEND_BATCH_MAX) {
    await env.QUEUE_CARDS.sendBatch(
      messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })),
    );
  }
  return messages.length;
}

const allVariants = () => [...CARD_VARIANTS];

/** True for a daily round: the only kind whose cards are public. */
async function isDaily(env: CardsQueueEnv, roundId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT kind FROM rounds WHERE id = ?1')
    .bind(roundId)
    .first<{ kind: string }>();
  return row?.kind === 'daily';
}

/** Every user who entered a mode (a foreign Stakes entry has no account, so no card). */
async function entrants(env: CardsQueueEnv, roundId: string, mode: Mode): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM entries
     WHERE round_id = ?1 AND mode = ?2 AND user_id IS NOT NULL`,
  )
    .bind(roundId, mode)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/**
 * The reveal fan-out: a `result` card for every player who entered the mode, plus the round card.
 * Returns how many messages were sent.
 */
export async function enqueueModeCards(
  env: CardsQueueEnv,
  roundId: string,
  mode: Mode,
): Promise<number> {
  if (!(await isDaily(env, roundId))) return 0;
  const users = await entrants(env, roundId, mode);
  const messages: CardsMessage[] = [
    { roundId, mode, kind: 'round', variants: allVariants() },
    ...users.map((userId): CardsMessage => ({
      roundId,
      mode,
      userId,
      kind: 'result',
      variants: allVariants(),
    })),
  ];
  return send(env, messages);
}

/** The teaser card for one player's sealed pick (the pre-reveal share; it never reads the pick). */
export function enqueueTeaserCard(
  env: CardsQueueEnv,
  roundId: string,
  mode: Mode,
  userId: string,
): Promise<number> {
  return send(env, [{ roundId, mode, userId, kind: 'teaser', variants: allVariants() }]);
}

/**
 * Re-render every card a round's mode already has, at the same keys: a veto, which changes the
 * outcome a card states. Deletion re-renders arrive the same way from `src/identity/delete.ts`.
 */
export async function enqueueModeRerender(
  env: CardsQueueEnv,
  roundId: string,
  mode: Mode,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, kind FROM share_cards WHERE round_id = ?1 AND mode = ?2`,
  )
    .bind(roundId, mode)
    .all<{ user_id: string; kind: 'result' | 'teaser' }>();
  const messages: CardsMessage[] = [
    { roundId, mode, kind: 'round', variants: allVariants() },
    ...results.map(({ user_id, kind }): CardsMessage => ({
      roundId,
      mode,
      userId: user_id,
      kind,
      variants: allVariants(),
    })),
  ];
  return send(env, messages);
}

/** Like the above, but never throws: a card is not worth failing the path that changed an outcome. */
export async function enqueueCardsSafely(
  env: CardsQueueEnv,
  roundId: string,
  mode: Mode,
  how: 'fan-out' | 're-render',
): Promise<number> {
  try {
    return how === 'fan-out'
      ? await enqueueModeCards(env, roundId, mode)
      : await enqueueModeRerender(env, roundId, mode);
  } catch (err) {
    log.error('card_enqueue_failed', {
      roundId,
      mode,
      how,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * The post-final hook (registered in src/settlement/hooks.ts): Free at apply or refund, and a Stakes
 * mode that became final without a proposal (`refundTooFew`, `refundTimeout`). The Stakes reveal
 * itself enqueues from the indexer's proposal handler, a challenge window earlier than this.
 */
export const cardsOnModeFinal: ModeFinalHandler = async (env, event) => {
  if (event.kind !== 'daily') return;
  await enqueueCardsSafely(env, event.roundId, event.mode, 'fan-out');
};
