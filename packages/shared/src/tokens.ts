// Schema for `design-tokens.json` (wave-2 plan P2.3). The design sessions own the JSON; this file only
// checks its shape, and CI runs the check (test/tokens.test.ts).
import { z } from 'zod';

const Hex = z.string().regex(/^#[0-9A-F]{6}$/, 'uppercase #RRGGBB');
const Px = z.number().nonnegative();

/** One colour scheme. Spec: Design_Language.md "Color tokens". */
export const ColorSchemeTokensSchema = z.strictObject({
  bg: Hex,
  surface: Hex,
  ink: Hex,
  muted: Hex,
  line: Hex,
  accent: Hex,
  accentInk: Hex,
});

export const TypeRoleTokenSchema = z.strictObject({
  font: z.enum(['display', 'body', 'numeric']),
  size: Px,
  lineHeight: Px,
  weight: z.number().int().min(100).max(900),
  tracking: z.number(),
});

export const MotionTokenSchema = z.strictObject({
  durationMs: z.number().int().positive(),
  easing: z
    .string()
    .regex(/^(linear|ease(-in|-out|-in-out)?|cubic-bezier\(([-0-9. ]+,){3}[-0-9. ]+\))$/),
});

const FontFamily = z.strictObject({
  family: z.string().min(1),
  weights: z.array(z.number().int().min(100).max(900)).min(1),
});

export const DesignTokensSchema = z.strictObject({
  version: z.literal('1'),
  color: z.strictObject({ light: ColorSchemeTokensSchema, dark: ColorSchemeTokensSchema }),
  font: z.strictObject({
    display: FontFamily,
    body: FontFamily,
    numeric: z.strictObject({ family: z.string().min(1), features: z.array(z.string()).min(1) }),
  }),
  type: z.record(z.string().regex(/^[a-z][A-Za-z]*$/), TypeRoleTokenSchema),
  space: z.array(z.number().int().nonnegative()).min(1),
  radius: z.strictObject({ card: Px, pill: Px }),
  border: z.strictObject({ strong: Px, default: Px }),
  motion: z.record(z.string().regex(/^[a-z][A-Za-z]*$/), MotionTokenSchema),
  breakpoints: z.strictObject({
    min: z.number().int().positive(),
    tablet: z.number().int().positive(),
    desktop: z.number().int().positive(),
  }),
});
export type DesignTokens = z.infer<typeof DesignTokensSchema>;
