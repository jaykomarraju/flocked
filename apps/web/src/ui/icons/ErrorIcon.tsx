// The error icon (Paper `icon/error`, Components › Feedback): a circled exclamation mark, 18px on a
// 16 grid, stroked in the text colour. Errors are ink with this icon, never a colour.
import type { SVGProps } from 'react';

export function ErrorIcon(props: SVGProps<SVGSVGElement>) {
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
        d="M8 4.5V9M8 11.5h.01M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
