// The nav-bar Today tab: a calendar (Paper Components › Navigation): a 22px line icon on a 24 grid, 2px stroke in
// the text colour (bg on the active tab's ink pill).
import type { SVGProps } from 'react';

export function TodayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M4 6.5h16v13H4zM4 10.5h16M8 4v4M16 4v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
