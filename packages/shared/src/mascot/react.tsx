// The mascot as a React component (`@flocked/shared/mascot/react`; Design_Language.md "Mascot"). It
// draws the pose data from ./poses.ts. The outline and wool keep their fixed colours in both themes;
// limbs (legs, motion and shock lines) paint with `var(--color-ink)` and the smug glint with
// `var(--color-accent)`, so they follow the theme the component sits in. Kept out of the package
// index so the API Worker never pulls in React.
import { useId } from 'react';
import {
  MASCOT_POSES,
  mascotColor,
  mascotSize,
  type MascotCircle,
  type MascotColorRole,
  type MascotEllipse,
  type MascotPath,
  type MascotPose,
  type MascotShape,
} from './poses';

/** Theme-following paints, set as `style` so `var()` resolves in every browser. */
const THEME_COLORS = { limb: 'var(--color-ink)', accent: 'var(--color-accent)' };

function isThemed(role: MascotColorRole): boolean {
  return role === 'limb' || role === 'accent';
}

function paintProps(shape: MascotPath | MascotCircle | MascotEllipse) {
  const { fill, stroke } = shape;
  const style: { fill?: string; stroke?: string } = {};
  let fillAttr = 'none';
  let strokeAttr: string | undefined;
  if (fill !== undefined) {
    if (isThemed(fill)) style.fill = mascotColor(fill, THEME_COLORS);
    else fillAttr = mascotColor(fill, THEME_COLORS);
  }
  if (stroke !== undefined) {
    if (isThemed(stroke)) style.stroke = mascotColor(stroke, THEME_COLORS);
    else strokeAttr = mascotColor(stroke, THEME_COLORS);
  }
  return {
    transform: shape.transform,
    fill: fillAttr,
    stroke: strokeAttr,
    strokeWidth: stroke === undefined ? undefined : shape.strokeWidth,
    strokeLinecap: stroke !== undefined && shape.kind === 'path' ? ('round' as const) : undefined,
    style: style.fill === undefined && style.stroke === undefined ? undefined : style,
  };
}

function Shape({ shape }: { shape: MascotShape }) {
  switch (shape.kind) {
    case 'path':
      return <path d={shape.d} {...paintProps(shape)} />;
    case 'circle':
      return <circle cx={shape.cx} cy={shape.cy} r={shape.r} {...paintProps(shape)} />;
    case 'ellipse':
      return (
        <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...paintProps(shape)} />
      );
    case 'group':
      return (
        <g transform={shape.transform}>
          <Shapes shapes={shape.children} />
        </g>
      );
    case 'svg':
      return (
        <svg
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          viewBox={shape.viewBox.join(' ')}
        >
          <Shapes shapes={shape.children} />
        </svg>
      );
  }
}

function Shapes({ shapes }: { shapes: readonly MascotShape[] }) {
  return shapes.map((shape, i) => <Shape key={i} shape={shape} />);
}

export interface MascotProps {
  pose: MascotPose;
  /** Width in px; the height follows the pose's aspect ratio. */
  size: number;
  /** The accessible name. Without one the sheep is decorative (`aria-hidden`). */
  title?: string;
  className?: string;
}

export function Mascot({ pose, size, title, className }: MascotProps) {
  const titleId = useId();
  const data = MASCOT_POSES[pose];
  const { width, height } = mascotSize(pose, size);
  const a11y =
    title === undefined
      ? { 'aria-hidden': true as const }
      : { role: 'img', 'aria-labelledby': titleId };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={data.viewBox.join(' ')}
      width={width}
      height={height}
      className={className}
      data-pose={pose}
      {...a11y}
    >
      {title !== undefined && <title id={titleId}>{title}</title>}
      <Shapes shapes={data.shapes} />
    </svg>
  );
}
