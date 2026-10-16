// The check (Paper `check`, Components › Option card and Actions): 14px on a 14 grid, stroked in the
// text colour. The option card's radio draws it at 14px with a 2.4 stroke; the mode toggle's selected
// segment at 16px with a 2.2 stroke (pass `width`, `height` and `strokeWidth`). The stroke attributes
// sit on the <svg> so the path inherits any override.
import type { SVGProps } from 'react';

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2.5 7.5L5.5 10.5L11.5 3.5" />
    </svg>
  );
}
