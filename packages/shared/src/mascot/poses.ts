// The mascot placeholders (Design_Language.md "Mascot"): one smug, unbothered sheep in five poses, as
// pure data copied from the Paper file (Foundations › `foundations/mascot/*/desktop`, layers
// `sheep/*`). No React here: the API Worker imports `@flocked/shared`, so the React component lives in
// `./react.tsx` (`@flocked/shared/mascot/react`) and `mascotSvg` renders a plain SVG string (share
// cards).
//
// Every shape names a colour role, not a colour:
//   outline  the ink outline, #141414 in both themes
//   wool     the white wool (and the head, ears and shocked eyes), #FFFFFF in both themes
//   limb     strokes outside the wool (legs, motion lines, shock lines): the theme's ink, so they stay
//            visible on the dark ground (`--color-ink`: #141414 light, #F5F2EC dark)
//   accent   the smug sheep's glint: the theme's accent (`--color-accent`)

/** The sheep's outline ink. Fixed in both themes (Design_Language.md "Mascot"); not a theme token. */
export const MASCOT_OUTLINE = '#141414';
/** The sheep's wool. Fixed in both themes (Design_Language.md "Mascot"); not a theme token. */
export const MASCOT_WOOL = '#FFFFFF';

/** The colour roles a mascot shape paints with (see the header comment). */
export const MASCOT_COLOR_ROLES = ['outline', 'wool', 'limb', 'accent'] as const;
export type MascotColorRole = (typeof MASCOT_COLOR_ROLES)[number];

/** Fill and stroke of a drawn shape. A missing `fill` is `none`; a missing `stroke` draws none. */
export interface MascotPaint {
  fill?: MascotColorRole;
  stroke?: MascotColorRole;
  /** Stroke width in viewBox units. Stroked paths always use round caps. */
  strokeWidth?: number;
  /** An SVG transform, as Paper has it. */
  transform?: string;
}

export interface MascotPath extends MascotPaint {
  kind: 'path';
  d: string;
}

export interface MascotCircle extends MascotPaint {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
}

export interface MascotEllipse extends MascotPaint {
  kind: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** A `<g>`, for a transform shared by its children. */
export interface MascotGroup {
  kind: 'group';
  transform?: string;
  children: readonly MascotShape[];
}

/** A nested `<svg>` viewport (the flock places whole sheep this way, as Paper does). */
export interface MascotViewport {
  kind: 'svg';
  x: number;
  y: number;
  width: number;
  height: number;
  viewBox: MascotViewBox;
  children: readonly MascotShape[];
}

export type MascotShape = MascotPath | MascotCircle | MascotEllipse | MascotGroup | MascotViewport;

/** `[minX, minY, width, height]`. */
export type MascotViewBox = readonly [number, number, number, number];

export const MASCOT_POSE_NAMES = ['neutral', 'smug', 'walking-away', 'shocked', 'flock'] as const;
/** The poses, named as Paper's `pose/*` layers. */
export type MascotPose = (typeof MASCOT_POSE_NAMES)[number];

export interface MascotPoseData {
  viewBox: MascotViewBox;
  shapes: readonly MascotShape[];
}

const SHEEP_VIEWBOX: MascotViewBox = [0, 0, 160, 140];

/** The wool's seven puffs: `[cx, cy, r]`. */
const WOOL_PUFFS = [
  [64, 62, 22],
  [88, 52, 24],
  [112, 62, 22],
  [120, 82, 18],
  [98, 92, 22],
  [72, 92, 22],
  [56, 80, 18],
] as const;

/** The puffs in outline ink with a 10-unit stroke, under the wool: the wool's outline. */
const WOOL_OUTLINE: MascotGroup = {
  kind: 'group',
  children: WOOL_PUFFS.map(([cx, cy, r]) => ({
    kind: 'circle',
    cx,
    cy,
    r,
    fill: 'outline',
    stroke: 'outline',
    strokeWidth: 10,
  })),
};

const WOOL: MascotGroup = {
  kind: 'group',
  children: WOOL_PUFFS.map(([cx, cy, r]) => ({ kind: 'circle', cx, cy, r, fill: 'wool' })),
};

const LEGS_STRAIGHT: MascotPath = {
  kind: 'path',
  d: 'M68 100v24M84 104v22M102 104v22M116 98v24',
  stroke: 'limb',
  strokeWidth: 7,
};

const HEAD: MascotEllipse = {
  kind: 'ellipse',
  cx: 40,
  cy: 74,
  rx: 19,
  ry: 23,
  fill: 'wool',
  stroke: 'outline',
  strokeWidth: 5,
};

const EAR_LEFT: MascotEllipse = {
  kind: 'ellipse',
  cx: 20,
  cy: 60,
  rx: 11,
  ry: 5.5,
  transform: 'rotate(-25 20 60)',
  fill: 'wool',
  stroke: 'outline',
  strokeWidth: 5,
};

const EAR_RIGHT: MascotEllipse = {
  kind: 'ellipse',
  cx: 60,
  cy: 58,
  rx: 11,
  ry: 5.5,
  transform: 'rotate(25 60 58)',
  fill: 'wool',
  stroke: 'outline',
  strokeWidth: 5,
};

/** Facial strokes (eyes, smirk) are 3.5 units, in outline ink. */
function faceStroke(d: string): MascotPath {
  return { kind: 'path', d, stroke: 'outline', strokeWidth: 3.5 };
}

function faceFill(d: string): MascotPath {
  return { kind: 'path', d, fill: 'outline' };
}

/** Default. Half-closed eyes, slight smirk. Empty and loading states. */
const NEUTRAL: MascotPoseData = {
  viewBox: SHEEP_VIEWBOX,
  shapes: [
    LEGS_STRAIGHT,
    WOOL_OUTLINE,
    WOOL,
    EAR_LEFT,
    EAR_RIGHT,
    HEAD,
    faceStroke('M27 70h9M44 70h9'),
    faceFill('M28.5 70a4 4 0 0 0 7 0zM45.5 70a4 4 0 0 0 7 0z'),
    faceStroke('M35 86q5 3 11-2'),
  ],
};

/** Win. Chin up, wider smirk, one accent glint. */
const SMUG: MascotPoseData = {
  viewBox: SHEEP_VIEWBOX,
  shapes: [
    LEGS_STRAIGHT,
    WOOL_OUTLINE,
    WOOL,
    {
      kind: 'group',
      transform: 'rotate(-14 40 74)',
      children: [
        EAR_LEFT,
        EAR_RIGHT,
        HEAD,
        faceStroke('M27 69l9 2M44 71l9-2'),
        faceFill('M29 71a3.5 3.5 0 0 0 6.5 1zM45 72a3.5 3.5 0 0 0 6.5-1z'),
        faceStroke('M33 86q8 4 15-5'),
      ],
    },
    { kind: 'path', d: 'M14 22v12M8 28h12', stroke: 'accent', strokeWidth: 4 },
  ],
};

/** Win animation. Alone, mid-stride, off-screen right (the sheep is the neutral one, mirrored). */
const WALKING_AWAY: MascotPoseData = {
  viewBox: SHEEP_VIEWBOX,
  shapes: [
    { kind: 'path', d: 'M4 66h14M0 82h16M6 98h12', stroke: 'limb', strokeWidth: 4 },
    {
      kind: 'group',
      transform: 'translate(164 0) scale(-1 1)',
      children: [
        {
          kind: 'path',
          d: 'M68 100l-7 22M84 104l7 22M102 104l-7 22M116 98l7 22',
          stroke: 'limb',
          strokeWidth: 7,
        },
        WOOL_OUTLINE,
        WOOL,
        EAR_LEFT,
        HEAD,
        faceStroke('M27 70h9'),
        faceFill('M28.5 70a4 4 0 0 0 7 0z'),
        faceStroke('M28 86q5 3 10-2'),
      ],
    },
  ],
};

/** Loss. Eyes open for once. Ears up. */
const SHOCKED: MascotPoseData = {
  viewBox: SHEEP_VIEWBOX,
  shapes: [
    {
      kind: 'path',
      d: 'M68 100l-4 24M84 104v22M102 104v22M116 98l4 24',
      stroke: 'limb',
      strokeWidth: 7,
    },
    WOOL_OUTLINE,
    WOOL,
    {
      kind: 'ellipse',
      cx: 18,
      cy: 52,
      rx: 11,
      ry: 5.5,
      transform: 'rotate(-55 18 52)',
      fill: 'wool',
      stroke: 'outline',
      strokeWidth: 5,
    },
    {
      kind: 'ellipse',
      cx: 62,
      cy: 50,
      rx: 11,
      ry: 5.5,
      transform: 'rotate(55 62 50)',
      fill: 'wool',
      stroke: 'outline',
      strokeWidth: 5,
    },
    HEAD,
    { kind: 'circle', cx: 32, cy: 69, r: 5.5, fill: 'wool', stroke: 'outline', strokeWidth: 3.5 },
    { kind: 'circle', cx: 48, cy: 69, r: 5.5, fill: 'wool', stroke: 'outline', strokeWidth: 3.5 },
    { kind: 'circle', cx: 32, cy: 69, r: 2, fill: 'outline' },
    { kind: 'circle', cx: 48, cy: 69, r: 2, fill: 'outline' },
    { kind: 'ellipse', cx: 40, cy: 86, rx: 4, ry: 5, fill: 'outline' },
    { kind: 'path', d: 'M14 30l6 8M40 22v10M66 30l-6 8', stroke: 'limb', strokeWidth: 4 },
  ],
};

/**
 * Where Paper puts each neutral sheep in the flock (`pose/flock`, a 560×180 frame): `[x, y]` of a
 * 150×131 viewport.
 */
const FLOCK_PLACES = [
  [0, 30],
  [100, 6],
  [200, 40],
  [300, 10],
  [400, 36],
] as const;

/** The "got flocked" state. Identical sheep, same expression, bunched together. */
const FLOCK: MascotPoseData = {
  viewBox: [0, 0, 560, 180],
  shapes: FLOCK_PLACES.map(([x, y]) => ({
    kind: 'svg',
    x,
    y,
    width: 150,
    height: 131,
    viewBox: SHEEP_VIEWBOX,
    children: NEUTRAL.shapes,
  })),
};

/** The five poses (Design_Language.md "Mascot" › Poses needed). */
export const MASCOT_POSES: Readonly<Record<MascotPose, MascotPoseData>> = {
  neutral: NEUTRAL,
  smug: SMUG,
  'walking-away': WALKING_AWAY,
  shocked: SHOCKED,
  flock: FLOCK,
};

/** The theme-dependent colours a rendering supplies (`outline` and `wool` are fixed). */
export interface MascotThemeColors {
  /** Legs, motion and shock lines: the theme's ink. */
  limb: string;
  /** The smug glint: the theme's accent. */
  accent: string;
}

/** The colour a role paints with. */
export function mascotColor(role: MascotColorRole, colors: MascotThemeColors): string {
  switch (role) {
    case 'outline':
      return MASCOT_OUTLINE;
    case 'wool':
      return MASCOT_WOOL;
    case 'limb':
      return colors.limb;
    case 'accent':
      return colors.accent;
  }
}

/** A pose's rendered size for a width in px (the height keeps the viewBox's aspect ratio). */
export function mascotSize(pose: MascotPose, width: number): { width: number; height: number } {
  if (!Number.isFinite(width) || width <= 0) {
    throw new RangeError(`mascot size must be a positive number, got ${width}`);
  }
  const [, , w, h] = MASCOT_POSES[pose].viewBox;
  return { width, height: (width * h) / w };
}

/** A number as an SVG attribute: at most 3 decimals, no trailing zeros. */
function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type Attr = [name: string, value: string | number | undefined];

function attrs(list: Attr[]): string {
  return list
    .filter((a): a is [string, string | number] => a[1] !== undefined)
    .map(([k, v]) => ` ${k}="${typeof v === 'number' ? num(v) : esc(v)}"`)
    .join('');
}

function paintAttrs(shape: MascotPath | MascotCircle | MascotEllipse, colors: MascotThemeColors) {
  const { fill, stroke } = shape;
  const paint: Attr[] = [
    ['transform', shape.transform],
    ['fill', fill === undefined ? 'none' : mascotColor(fill, colors)],
  ];
  if (stroke === undefined) return paint;
  return paint.concat([
    ['stroke', mascotColor(stroke, colors)],
    ['stroke-width', shape.strokeWidth],
    ['stroke-linecap', shape.kind === 'path' ? 'round' : undefined],
  ]);
}

function shapeSvg(shape: MascotShape, colors: MascotThemeColors): string {
  switch (shape.kind) {
    case 'path':
      return `<path${attrs([['d', shape.d], ...paintAttrs(shape, colors)])}/>`;
    case 'circle':
      return `<circle${attrs([
        ['cx', shape.cx],
        ['cy', shape.cy],
        ['r', shape.r],
        ...paintAttrs(shape, colors),
      ])}/>`;
    case 'ellipse':
      return `<ellipse${attrs([
        ['cx', shape.cx],
        ['cy', shape.cy],
        ['rx', shape.rx],
        ['ry', shape.ry],
        ...paintAttrs(shape, colors),
      ])}/>`;
    case 'group':
      return `<g${attrs([['transform', shape.transform]])}>${shapesSvg(shape.children, colors)}</g>`;
    case 'svg':
      return `<svg${attrs([
        ['x', shape.x],
        ['y', shape.y],
        ['width', shape.width],
        ['height', shape.height],
        ['viewBox', shape.viewBox.map(num).join(' ')],
      ])}>${shapesSvg(shape.children, colors)}</svg>`;
  }
}

function shapesSvg(shapes: readonly MascotShape[], colors: MascotThemeColors): string {
  return shapes.map((s) => shapeSvg(s, colors)).join('');
}

/**
 * A pose as a standalone SVG document string (share cards; no DOM needed). `limb` and `accent` are
 * the theme's ink and accent; `size` is the width in px (default: the viewBox width).
 */
export function mascotSvg(pose: MascotPose, opts: MascotThemeColors & { size?: number }): string {
  const data = MASCOT_POSES[pose];
  const { width, height } = mascotSize(pose, opts.size ?? data.viewBox[2]);
  const colors = { limb: opts.limb, accent: opts.accent };
  return (
    `<svg${attrs([
      ['xmlns', 'http://www.w3.org/2000/svg'],
      ['viewBox', data.viewBox.map(num).join(' ')],
      ['width', width],
      ['height', height],
    ])}>` +
    shapesSvg(data.shapes, colors) +
    '</svg>'
  );
}
