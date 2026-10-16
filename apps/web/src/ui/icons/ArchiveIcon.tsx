// The nav-bar Archive tab: an archive box (Paper Components › Navigation): a 22px line icon on a 24 grid, 2px stroke in
// the text colour (bg on the active tab's ink pill).
import type { SVGProps } from 'react';

export function ArchiveIcon(props: SVGProps<SVGSVGElement>) {
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
        d="M3.5 5h17v4h-17zM5 9v10h14V9M10 13h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
