// Where a card lives in R2 (wave-10 pinned interface):
//
//   cards/{roundId}/{mode}/{userId}/{kind}/{variant}.png   a player's result or teaser card
//   cards/{roundId}/{mode}/round/{variant}.png             the generic round card (no player)
//
// `share_cards.r2_prefix` holds everything up to the variant, so a row names its own objects.
import type { CardKind, CardVariant, Mode } from '@flocked/shared';

/** The prefix a card's three variants share. `userId` is absent only for the round card. */
export function cardPrefix(
  roundId: string,
  mode: Mode,
  kind: CardKind,
  userId?: string | null,
): string {
  if (kind === 'round') return `cards/${roundId}/${mode}/round/`;
  if (!userId) throw new Error(`a ${kind} card needs a userId`);
  return `cards/${roundId}/${mode}/${userId}/${kind}/`;
}

/** One variant's object key under a prefix. */
export function cardKey(prefix: string, variant: CardVariant): string {
  return `${prefix}${variant}.png`;
}

/** The public path a card image is served at (`/cards/:shareId/:variant.png`). */
export function cardImagePath(shareId: string, variant: CardVariant): string {
  return `/cards/${shareId}/${variant}.png`;
}

/** The public path a round card is served at (`/rounds/:id/card/:variant.png`). */
export function roundCardPath(roundId: string, variant: CardVariant): string {
  return `/rounds/${roundId}/card/${variant}.png`;
}

/** The share page's path. */
export function sharePagePath(shareId: string): string {
  return `/s/${shareId}`;
}
