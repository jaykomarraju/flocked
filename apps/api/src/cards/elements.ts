// The card as a satori element tree: one `CardModel` plus one variant's `CardGeometry` (the Paper
// artboard's own numbers) in, satori nodes out. Flex only — no grid, no transforms, no tabular
// figures — because that is the subset satori lays out, and the artboards' notes bands are written
// to it. The sheep (and the flock) go in as one inline SVG `img`, since their shapes carry inner
// transforms satori would otherwise drop.
import { mascotSize, mascotSvg, type MascotPose } from '@flocked/shared';
import { CARD_COLORS as C, type CardGeometry } from './geometry.js';
import {
  CARD_TEASER_LINE,
  CARD_URL,
  streakLabel,
  type CardModel,
  type CardOption,
} from './model.js';

/** A satori node. satori takes React elements or these plain objects, which need no JSX runtime. */
export interface El {
  type: string;
  props: Record<string, unknown>;
}

type Child = El | string | null | false;
type Style = Record<string, string | number>;

function h(type: string, style: Style, ...children: Child[]): El {
  const kids = children.filter((c): c is El | string => c !== null && c !== false);
  return {
    type,
    props: { style, ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) },
  };
}

const px = (n: number) => `${n}px`;

/** "A. B" as ["A.", "B"]: the teaser's big line sets one sentence per line (its artboard). */
function sentences(value: string): string[] {
  const parts = value.match(/[^.?!]+[.?!]*\s*/g);
  return parts ? parts.map((p) => p.trim()).filter(Boolean) : [value];
}

/** A text run. satori needs the family, size, weight and line height on the text node itself. */
function text(
  value: string,
  opts: {
    family: 'Fredoka' | 'Inter';
    size: number;
    line: number;
    weight: 500 | 600 | 700;
    color: string;
    /** Tracking in em, as the artboards declare it; satori is happier with px. */
    tracking?: number;
    style?: Style;
  },
): El {
  return h(
    'div',
    {
      fontFamily: opts.family,
      fontSize: px(opts.size),
      lineHeight: px(opts.line),
      fontWeight: opts.weight,
      color: opts.color,
      ...(opts.tracking ? { letterSpacing: px(opts.tracking * opts.size) } : {}),
      ...opts.style,
    },
    value,
  );
}

/**
 * The mascot as an `<img>` of its own SVG (Foundations colours: ink limbs, the accent glint). A pose
 * goes in whole, with its inner transforms, which satori drops from ordinary elements. The five-sheep
 * flock is a wide viewBox (560×180), so it has its own width; every other pose keeps `sheepWidth`.
 */
function sheep(pose: MascotPose, g: CardGeometry): El {
  const { width, height } = mascotSize(pose, pose === 'flock' ? g.flockWidth : g.sheepWidth);
  const svg = mascotSvg(pose, { limb: C.ink, accent: C.accent, size: width });
  return {
    type: 'img',
    props: {
      src: `data:image/svg+xml;base64,${btoa(svg)}`,
      width: Math.round(width),
      height: Math.round(height),
      style: { width: px(Math.round(width)), height: px(Math.round(height)), flexShrink: 0 },
    },
  };
}

/** A pill: the stray streak (accent) and the sealed badge (ink). */
function pill(
  label: string,
  g: CardGeometry,
  kind: 'streak' | 'sealed',
  size = g.badgeSize,
  line = g.badgeLine,
  height = g.badgeHeight,
): El {
  const sealed = kind === 'sealed';
  const lock = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 16" width="${Math.round(
    size * 0.8,
  )}" height="${Math.round(size * 0.92)}"><path d="M3.5 7V5a3.5 3.5 0 0 1 7 0v2M2 7h10v7.5H2z" fill="none" stroke="${
    C.bg
  }" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
  return h(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      flexShrink: 0,
      height: px(height),
      paddingLeft: px(sealed ? g.badgePadding - 4 : g.badgePadding),
      paddingRight: px(g.badgePadding),
      gap: px(Math.round(size * 0.36)),
      borderRadius: '999px',
      backgroundColor: sealed ? C.ink : C.accent,
    },
    sealed
      ? {
          type: 'img',
          props: {
            src: `data:image/svg+xml;base64,${btoa(lock)}`,
            width: Math.round(size * 0.8),
            height: Math.round(size * 0.92),
            style: { flexShrink: 0 },
          },
        }
      : null,
    text(label, {
      family: sealed ? 'Inter' : 'Fredoka',
      size,
      line,
      weight: sealed ? 600 : 700,
      color: sealed ? C.bg : C.accentInk,
    }),
  );
}

/** The header row: the mode and day label, with the streak pill or the sealed badge on its right. */
function header(m: CardModel, g: CardGeometry): El {
  return h(
    'div',
    {
      display: 'flex',
      flexShrink: 0,
      height: px(g.headerHeight),
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    text(m.meta, {
      family: 'Inter',
      size: g.metaSize,
      line: g.metaLine,
      weight: 600,
      color: C.muted,
    }),
    m.streak !== null && m.streak >= 2
      ? pill(streakLabel(m.streak), g, 'streak')
      : m.sealed && m.kind === 'teaser'
        ? pill('Sealed', g, 'sealed')
        : null,
  );
}

/** One split bar: the label row (with "Your pick" and the % in a fixed slot), then the track. */
function bar(o: CardOption, g: CardGeometry): El {
  return h(
    'div',
    { display: 'flex', flexDirection: 'column', gap: px(g.barGap) },
    h(
      'div',
      {
        display: 'flex',
        flexShrink: 0,
        height: px(g.labelRowHeight),
        alignItems: 'center',
        justifyContent: 'space-between',
      },
      h(
        'div',
        { display: 'flex', alignItems: 'center', gap: px(12) },
        text(o.label, {
          family: 'Fredoka',
          size: g.labelSize,
          line: g.labelLine,
          weight: 600,
          color: C.ink,
        }),
        o.picked
          ? h(
              'div',
              {
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
                height: px(g.pickPillHeight),
                paddingLeft: px(g.pickPillPadding),
                paddingRight: px(g.pickPillPadding),
                borderRadius: '999px',
                backgroundColor: C.ink,
              },
              text('Your pick', {
                family: 'Inter',
                size: g.pickPillSize,
                line: g.pickPillLine,
                weight: 600,
                color: C.bg,
              }),
            )
          : null,
      ),
      o.pct === null
        ? null
        : text(o.pct, {
            family: 'Inter',
            size: g.pctSize,
            line: g.pctLine,
            weight: 700,
            color: C.ink,
            style: {
              display: 'flex',
              flexShrink: 0,
              width: px(g.pctWidth),
              justifyContent: 'flex-end',
              textAlign: 'right',
            },
          }),
    ),
    h(
      'div',
      {
        display: 'flex',
        flexShrink: 0,
        height: px(g.trackHeight),
        borderRadius: '999px',
        backgroundColor: C.line,
      },
      h('div', {
        height: px(g.trackHeight),
        width: `${o.fill}%`,
        borderRadius: '999px',
        backgroundColor: o.winner ? C.accent : C.ink,
      }),
    ),
  );
}

/** The middle block: the split bars, the entrant count, or the teaser's two outlines. */
function middle(m: CardModel, g: CardGeometry): El {
  if (m.bars) {
    return h(
      'div',
      { display: 'flex', flexDirection: 'column', flexShrink: 0, gap: px(g.barsGap) },
      bar(m.options[0], g),
      bar(m.options[1], g),
    );
  }
  if (m.outlines) {
    return h(
      'div',
      { display: 'flex', flexShrink: 0, gap: px(g.optionGap) },
      ...m.options.map((o) =>
        h(
          'div',
          {
            display: 'flex',
            flexGrow: 1,
            flexBasis: '0px',
            alignItems: 'center',
            height: px(g.optionBoxHeight),
            paddingLeft: px(g.optionBoxPadding),
            paddingRight: px(g.optionBoxPadding),
            border: `2px solid ${C.ink}`,
            borderRadius: px(g.optionBoxRadius),
          },
          text(o.label, {
            family: 'Fredoka',
            size: g.labelSize,
            line: g.labelLine,
            weight: 600,
            color: C.ink,
          }),
        ),
      ),
    );
  }
  return h(
    'div',
    { display: 'flex', flexShrink: 0, alignItems: 'center', gap: px(g.countGap) },
    text(m.count ?? '', {
      family: 'Fredoka',
      size: g.countSize,
      line: g.countLine,
      weight: 700,
      color: C.ink,
    }),
    m.sealed ? pill('Sealed', g, 'sealed') : null,
  );
}

/**
 * The result row, bottom-aligned: the line (and its value) beside the sheep. `og` and `embed` set
 * the label and value as two runs in one wrapping row, so the value never breaks alone; `square`
 * stacks them. A refund puts its why line under the title instead.
 */
function result(m: CardModel, g: CardGeometry, resultSize: number): El {
  const teaser = m.kind === 'teaser';
  const stacked = g.stackResult || m.note !== null || teaser;
  const lineStyle = {
    family: 'Fredoka' as const,
    size: teaser ? g.teaserSize : resultSize,
    line: teaser ? g.teaserLine : g.stackResult ? g.resultLine : resultSize,
    weight: 700 as const,
    color: m.resultAccent ? C.accent : C.ink,
    // The win and loss lines are tracked open a hundredth; the refund title is tracked in (its
    // artboard's own values).
    tracking: teaser ? undefined : m.note !== null ? -0.01 : 0.01,
  };
  // The teaser's line is a sentence pair, and the artboard breaks it between the two.
  const label = teaser
    ? h(
        'div',
        { display: 'flex', flexDirection: 'column' },
        ...sentences(m.resultLabel).map((s) => text(s, lineStyle)),
      )
    : text(m.resultLabel, lineStyle);
  return h(
    'div',
    {
      display: 'flex',
      flexShrink: 0,
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: px(g.resultGap),
    },
    h(
      'div',
      {
        display: 'flex',
        flexGrow: 1,
        flexBasis: '0px',
        minWidth: '0px',
        ...(stacked
          ? { flexDirection: 'column', alignItems: 'flex-start', gap: px(m.note ? g.noteGap : 0) }
          : { flexWrap: 'wrap', alignItems: 'baseline', columnGap: px(g.resultValueGap) }),
      },
      label,
      m.resultValue === null
        ? null
        : text(m.resultValue, {
            family: 'Fredoka',
            size: resultSize,
            line: g.stackResult ? g.resultLine : resultSize,
            weight: 700,
            color: m.resultAccent ? C.accent : C.ink,
            tracking: 0.01,
          }),
      m.note === null
        ? null
        : text(m.note, {
            family: 'Inter',
            size: g.noteSize,
            line: g.noteLine,
            weight: 600,
            color: C.ink,
          }),
    ),
    sheep(m.pose, g),
  );
}

/** The footer: handle and avatar left, wordmark and URL right. A round card keeps only the brand. */
function footer(m: CardModel, g: CardGeometry): El {
  return h(
    'div',
    {
      display: 'flex',
      flexShrink: 0,
      height: px(g.footerHeight),
      alignItems: 'center',
      justifyContent: m.handle === null ? 'flex-end' : 'space-between',
    },
    m.handle === null
      ? null
      : h(
          'div',
          { display: 'flex', alignItems: 'center', gap: px(g.handleGap) },
          h(
            'div',
            {
              display: 'flex',
              flexShrink: 0,
              width: px(g.avatarSize),
              height: px(g.avatarSize),
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '999px',
              border: `2px solid ${C.ink}`,
              backgroundColor: C.surface,
            },
            text(m.handle.slice(0, 1).toUpperCase(), {
              family: 'Fredoka',
              size: g.avatarLetterSize,
              line: g.avatarLetterLine,
              weight: 600,
              color: C.ink,
            }),
          ),
          text(`@${m.handle}`, {
            family: 'Inter',
            size: g.handleSize,
            line: g.handleLine,
            weight: 600,
            color: C.ink,
          }),
        ),
    h(
      'div',
      { display: 'flex', alignItems: 'baseline', gap: px(g.wordmarkGap) },
      text('Flocked', {
        family: 'Fredoka',
        size: g.wordmarkSize,
        line: g.wordmarkLine,
        weight: 700,
        color: C.ink,
      }),
      text(CARD_URL, {
        family: 'Inter',
        size: g.urlSize,
        line: g.urlLine,
        weight: 500,
        color: C.muted,
      }),
    ),
  );
}

/**
 * The whole card. `questionSize` and `resultSize` are stepped down by the caller until the text
 * fits (spec "Card content"): the question and the result line each drop 4 px at a time, to floors
 * of 32 px and 56 px.
 */
export function cardElement(
  m: CardModel,
  g: CardGeometry,
  sizes: { questionSize: number; resultSize: number },
): El {
  return h(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      width: px(g.width),
      height: px(g.height),
      paddingTop: px(g.padBlock),
      paddingBottom: px(g.padBlock),
      paddingLeft: px(g.padInline),
      paddingRight: px(g.padInline),
      backgroundColor: C.bg,
      overflow: 'hidden',
    },
    header(m, g),
    text(m.question, {
      family: 'Fredoka',
      size: sizes.questionSize,
      line: Math.round((g.questionLine / g.questionSize) * sizes.questionSize),
      weight: 600,
      color: C.ink,
      tracking: -0.01,
      style: { maxWidth: px(g.questionMaxWidth) },
    }),
    middle(m, g),
    result(m, g, sizes.resultSize),
    footer(m, g),
  );
}

/** The teaser's big line, so a caller can build the model's label without importing the copy. */
export const TEASER_LINE = CARD_TEASER_LINE;
