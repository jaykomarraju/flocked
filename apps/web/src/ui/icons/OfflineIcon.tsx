// The offline icon (Paper `icon/offline`, Components › Feedback): a struck-through wifi fan, 18px on
// a 16 grid, stroked in the text colour.
import type { SVGProps } from 'react';

export function OfflineIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M1.5 6a9.5 9.5 0 0 1 13 0M4 8.8a6 6 0 0 1 8 0M6.5 11.4a2.4 2.4 0 0 1 3 0M2 2l12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
