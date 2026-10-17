// The verify mark (Paper `core/today/open-stakes-unverified` › callout, and the verification sheet):
// a shield with a tick, 24px on a 24 grid, stroked at 2 in the text colour, like the other screen
// icons that are not in the kit (docs/design/README.md "Kit and screen conventions (W9-Z)").
import type { SVGProps } from 'react';

export function ShieldCheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 3 4.5 6v5.5c0 4.2 3 7.6 7.5 9 4.5-1.4 7.5-4.8 7.5-9V6z" />
      <path d="m9 12 2.1 2.1L15 10.2" />
    </svg>
  );
}
