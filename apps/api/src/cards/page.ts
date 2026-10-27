// The share page's HTML (spec "Share cards and distribution" › Share surfaces; Paper
// `cards/share-page/{result,teaser-open,teaser-revealed}`). One small self-contained page: the card
// image, who shared it, and the one primary action, with the OG and Farcaster mini app embed tags
// that make a cast or a link preview show the card with a "Play today's Flocked" button.
//
// Share IDs are opaque and stable, so a page's URL survives a handle change or a re-render.
import type { CardKind, CardVariant, Mode } from '@flocked/shared';
import { CARD_COLORS } from './geometry.js';
import { CARD_URL } from './model.js';

/** The embed's button, at most 32 characters (Farcaster's limit). */
export const PLAY_CTA = "Play today's Flocked";

export interface SharePageData {
  shareId: string;
  kind: CardKind;
  mode: Mode;
  /** The sharer's handle, or null once their account is deleted. */
  handle: string | null;
  /** "Free · Oct 12". */
  meta: string;
  question: string;
  /** The round, once its mode has revealed: the page links to it. */
  roundId: string | null;
  revealed: boolean;
  /** The sharer's referral code, carried into the app by the Play link. */
  ref: string | null;
  origin: string;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The card image's absolute URL for a variant. */
export function imageUrl(d: SharePageData, variant: CardVariant): string {
  return `${d.origin}/cards/${d.shareId}/${variant}.png`;
}

/** Where the Play button goes: the app, carrying the sharer's ref code and this share ID. */
export function playUrl(d: SharePageData): string {
  const params = new URLSearchParams();
  if (d.ref) params.set('ref', d.ref);
  params.set('share', d.shareId);
  return `${d.origin}/?${params.toString()}`;
}

/** The headline: a result page names the sharer, a teaser says they sealed a pick. */
export function headline(d: SharePageData): string {
  const who = d.handle ? `@${d.handle}` : 'Someone';
  if (d.kind !== 'teaser') return `${who} · ${d.meta}`;
  return d.revealed ? `${who} sealed a pick. The round has revealed.` : `${who} sealed a pick.`;
}

/**
 * The Farcaster mini app embed (`fc:miniapp`, with `fc:frame` for clients that still read the older
 * name). The image is the 3:2 `embed` variant; the button launches the mini app at the Play link.
 */
export function embedMeta(d: SharePageData): { miniapp: string; frame: string } {
  const embed = (type: 'launch_miniapp' | 'launch_frame') =>
    JSON.stringify({
      version: '1',
      imageUrl: imageUrl(d, 'embed'),
      button: {
        title: PLAY_CTA,
        action: { type, name: 'Flocked', url: playUrl(d) },
      },
    });
  return { miniapp: embed('launch_miniapp'), frame: embed('launch_frame') };
}

/** The share page. */
export function sharePageHtml(d: SharePageData): string {
  const title = d.kind === 'teaser' ? 'A sealed pick on Flocked' : `${headline(d)} · Flocked`;
  const description =
    d.kind === 'teaser'
      ? 'I sealed my pick. Can you out-think the flock?'
      : `${d.question} — the side fewer people pick wins.`;
  const meta = embedMeta(d);
  const round = d.roundId && d.revealed ? `${d.origin}/r/${d.roundId}` : null;
  const roundLabel = d.kind === 'teaser' ? 'See the reveal' : 'See the round';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(`${d.origin}/s/${d.shareId}`)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Flocked">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(`${d.origin}/s/${d.shareId}`)}">
<meta property="og:image" content="${esc(imageUrl(d, 'og'))}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(imageUrl(d, 'og'))}">
<meta name="fc:miniapp" content="${esc(meta.miniapp)}">
<meta name="fc:frame" content="${esc(meta.frame)}">
<style>
:root { color-scheme: light }
* { box-sizing: border-box }
body { margin: 0; background: ${CARD_COLORS.bg}; color: ${CARD_COLORS.ink};
  font: 500 16px/1.5 Inter, system-ui, -apple-system, sans-serif;
  display: flex; flex-direction: column; align-items: center; min-height: 100vh; padding: 24px }
header, main, footer { width: 100%; max-width: 560px }
header { display: flex; align-items: baseline; gap: 12px; padding: 8px 0 24px }
.wordmark { font-weight: 700; font-size: 22px; letter-spacing: -0.01em }
.url { color: ${CARD_COLORS.muted}; font-size: 14px }
h1 { font-size: 20px; line-height: 1.3; margin: 0 0 16px; font-weight: 600 }
img.card { width: 100%; height: auto; display: block; border-radius: 16px;
  border: 2px solid ${CARD_COLORS.line}; background: ${CARD_COLORS.surface} }
.actions { display: flex; flex-direction: column; gap: 12px; padding: 24px 0 }
a.cta { display: flex; align-items: center; justify-content: center; height: 56px;
  border-radius: 999px; background: ${CARD_COLORS.accent}; color: ${CARD_COLORS.accentInk};
  font-weight: 700; text-decoration: none }
a.secondary { display: flex; align-items: center; justify-content: center; height: 48px;
  border-radius: 999px; border: 2px solid ${CARD_COLORS.ink}; color: ${CARD_COLORS.ink};
  background: ${CARD_COLORS.surface}; font-weight: 600; text-decoration: none }
footer { color: ${CARD_COLORS.muted}; font-size: 14px; padding: 8px 0 24px }
</style>
</head>
<body>
<header><span class="wordmark">Flocked</span><span class="url">${CARD_URL}</span></header>
<main>
<h1>${esc(headline(d))}</h1>
<img class="card" src="${esc(imageUrl(d, 'og'))}" width="1200" height="630"
  alt="${esc(d.kind === 'teaser' ? 'A sealed pick: the question, not the pick' : 'A Flocked result card')}">
<div class="actions">
<a class="cta" href="${esc(playUrl(d))}">${PLAY_CTA}</a>
${round ? `<a class="secondary" href="${esc(round)}">${roundLabel}</a>` : ''}
</div>
</main>
<footer>One question a day. The side fewer people pick wins.</footer>
</body>
</html>
`;
}
