// The card fonts for satori: Fredoka 600/700 (display) and Inter 500/600/700 (body), as static TTFs.
// The bytes live in fonts.gen.ts as base64, generated from apps/api/assets/fonts/*.ttf — the one form
// wrangler's esbuild and Vite (which builds the Workers tests) bundle the same way. Decoding all five
// takes about a millisecond, and the module-level cache means a warm isolate pays it once.
import { FONT_DATA_BASE64, type FontKey } from './fonts.gen.js';

export interface CardFont {
  name: 'Fredoka' | 'Inter';
  data: Uint8Array;
  weight: 500 | 600 | 700;
  style: 'normal';
}

const FACES: readonly { key: FontKey; name: 'Fredoka' | 'Inter'; weight: 500 | 600 | 700 }[] = [
  { key: 'fredoka-600', name: 'Fredoka', weight: 600 },
  { key: 'fredoka-700', name: 'Fredoka', weight: 700 },
  { key: 'inter-500', name: 'Inter', weight: 500 },
  { key: 'inter-600', name: 'Inter', weight: 600 },
  { key: 'inter-700', name: 'Inter', weight: 700 },
];

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

let cache: CardFont[] | null = null;

/** The five faces, decoded once per isolate. */
export function cardFonts(): CardFont[] {
  cache ??= FACES.map(({ key, name, weight }) => ({
    name,
    weight,
    style: 'normal' as const,
    data: decode(FONT_DATA_BASE64[key]),
  }));
  return cache;
}
