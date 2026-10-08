// Share pages and card images (route module `cards`). Spec: "API", "Share cards and
// distribution", "Data model" (`share_cards`). These routes answer HTML and PNG, not JSON.

import { z } from 'zod';

import { ShareIdSchema, UlidSchema } from '../wire';

/** Card kinds: a player's `result` and pre-reveal `teaser` (`share_cards.kind`), and the `round`
 * card (split only, no player). */
export const CARD_KINDS = ['result', 'teaser', 'round'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const CardKindSchema = z.enum(CARD_KINDS);

/** Card variants: `og` 1200x630, `embed` 1200x800 (3:2), `square` 1080x1080. */
export const CARD_VARIANTS = ['og', 'embed', 'square'] as const;
export type CardVariant = (typeof CARD_VARIANTS)[number];
export const CardVariantSchema = z.enum(CARD_VARIANTS);

/**
 * The `:variant.png` path segment. Hono reads the spec's `:variant.png` as a parameter named
 * `variant.png`, so the routes use `:variant{(?:og|embed|square)\.png}` and the parameter value
 * includes the extension.
 */
export const CARD_IMAGE_FILES = ['og.png', 'embed.png', 'square.png'] as const;
export type CardImageFile = (typeof CARD_IMAGE_FILES)[number];

/** `og.png` → `og`. */
export function cardVariantOfFile(file: CardImageFile): CardVariant {
  return file.slice(0, -'.png'.length) as CardVariant;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG body (checked by its 8-byte signature). */
export const PngImageSchema = z.custom<Uint8Array>(
  (v) => v instanceof Uint8Array && PNG_MAGIC.every((b, i) => v[i] === b),
  'expected PNG bytes',
);

// GET /s/:shareId -------------------------------------------------------------------------------

export const SharePageParamsSchema = z.object({ shareId: ShareIdSchema });
export type SharePageParams = z.infer<typeof SharePageParamsSchema>;

/** GET /s/:shareId: an HTML page (text/html) with OG and Farcaster embed tags. */
export const SharePageResponseSchema = z.string().min(1);

// GET /cards/:shareId/:variant.png --------------------------------------------------------------

export const CardImageParamsSchema = z.object({
  shareId: ShareIdSchema,
  variant: z.enum(CARD_IMAGE_FILES),
});
export type CardImageParams = z.infer<typeof CardImageParamsSchema>;

/** GET /cards/:shareId/:variant.png: image/png from R2. */
export const CardImageResponseSchema = PngImageSchema;

// GET /rounds/:id/card/:variant.png -------------------------------------------------------------

export const RoundCardParamsSchema = z.object({
  id: UlidSchema,
  variant: z.enum(CARD_IMAGE_FILES),
});
export type RoundCardParams = z.infer<typeof RoundCardParamsSchema>;

/** GET /rounds/:id/card/:variant.png: the round card (split only); 404 until the mode reveals. */
export const RoundCardResponseSchema = PngImageSchema;
