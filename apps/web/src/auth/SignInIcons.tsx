// The sign-in providers' icons (Paper `core/sign-in/browser/*`, the provider pills): 22px on a 22
// grid, 2px round strokes in the text colour. Decorative: the pill's label names the provider.
import type { SVGProps } from 'react';

function Icon({ d, ...props }: SVGProps<SVGSVGElement> & { d: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Farcaster: the arch. */
export function FarcasterIcon(props: SVGProps<SVGSVGElement>) {
  return <Icon d="M4 19V8l7-4 7 4v11 M8 19v-6h6v6" {...props} />;
}

/** A wallet. */
export function WalletIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon
      d="M3 7h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h10 M15 13h1"
      {...props}
    />
  );
}

/** An envelope. */
export function MailIcon(props: SVGProps<SVGSVGElement>) {
  return <Icon d="M3 5h16v12H3z M3 6l8 6 8-6" {...props} />;
}
