// The loading spinner (Paper, Components › Actions, the CTA's loading state): a three-quarter ring,
// 20px on a 20 grid, stroked in the text colour. It is drawn still; the component that shows it spins
// it (and reduced motion stops it, base theme).
import type { SVGProps } from 'react';

export function SpinnerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M10 2.5A7.5 7.5 0 1 1 2.5 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
