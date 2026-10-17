// Rendering one card: satori lays the element tree out as an SVG, resvg rasterises it to a PNG
// (spec "Share cards and distribution" › Generation: "satori + resvg-wasm in a Worker").
//
// Both libraries carry WebAssembly, and workerd never compiles WebAssembly from bytes at runtime, so
// each module is imported (wrangler and Vite both resolve a `.wasm` import to a `WebAssembly.Module`)
// and handed to the library's own initialiser once per isolate. satori is pinned to 0.32.0: from
// 0.33 it imports harfbuzzjs, whose emscripten glue instantiates its module at import time, which
// workerd refuses — so a newer satori cannot load in a Worker at all (W10-A handoff).
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import satori, { init as initLayout } from 'satori/standalone';
import yogaWasm from 'satori/yoga.wasm';
import type { CardVariant } from '@flocked/shared';
import { cardElement } from './elements.js';
import { fitQuestionSize, fitResultSize } from './fit.js';
import { cardFonts } from './fonts.js';
import { CARD_GEOMETRY } from './geometry.js';
import type { CardModel } from './model.js';

let ready: Promise<void> | null = null;

/** Initialises both WebAssembly modules, once per isolate (concurrent callers share the promise). */
export function initCardRenderer(): Promise<void> {
  ready ??= (async () => {
    await initLayout(yogaWasm);
    await initWasm(resvgWasm);
  })().catch((err: unknown) => {
    // A failed init must not poison the isolate: the next call tries again.
    ready = null;
    throw err;
  });
  return ready;
}

/** One card as an SVG string (the step before rasterising; the pixel tests use both). */
export async function renderCardSvg(m: CardModel, variant: CardVariant): Promise<string> {
  await initCardRenderer();
  const g = CARD_GEOMETRY[variant];
  const svg = await satori(
    cardElement(m, g, {
      questionSize: fitQuestionSize(m.question, g),
      resultSize: fitResultSize(m, g),
    }) as never,
    { width: g.width, height: g.height, fonts: cardFonts() },
  );
  return svg;
}

/** One card as PNG bytes at the variant's own size. */
export async function renderCard(m: CardModel, variant: CardVariant): Promise<Uint8Array> {
  const svg = await renderCardSvg(m, variant);
  const g = CARD_GEOMETRY[variant];
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: g.width },
    background: 'rgba(0,0,0,0)',
  })
    .render()
    .asPng();
}
