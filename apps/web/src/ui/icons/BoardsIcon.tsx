// The nav-bar Boards tab: a podium of three bars (Paper Components › Navigation): a 22px line icon on a 24 grid, 2px stroke in
// the text colour (bg on the active tab's ink pill).
import type { SVGProps } from 'react';

export function BoardsIcon(props: SVGProps<SVGSVGElement>) {
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
        d="M4 20v-7h5v7M9 20V8h6v12M15 20v-9h5v9M3 20h18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
