// The padlock (Paper Components › Round status, Stake selector): a 14×16 line icon, 1.8 stroke in the text
// colour. The sealed badge and the fixed-stake box draw it at 14×16; the sealed pick draws it at 22×26
// with a 1.6 stroke (pass `width`, `height` and `strokeWidth`: the path inherits them from the svg).
import type { SVGProps } from 'react';

export function PadlockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="14"
      height="16"
      viewBox="0 0 14 16"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3.5 7V5a3.5 3.5 0 0 1 7 0v2M2 7h10v7.5H2z" />
    </svg>
  );
}
