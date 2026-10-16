// The navigation (spec "Client app" › Navigation; Decision log Oct 8, 9 and 12): five tabs, and the
// You links (the You sheet on mobile, the header's avatar menu from tablet up, never header links).
// Its own module, so components can import it without importing the route table (no cycle through
// routes.tsx → AppShell → NavBar).
/** The five tabs (spec "Client app" › Navigation), in order. */
export const TABS = [
  { id: 'today', label: 'Today', path: '/' },
  { id: 'archive', label: 'Archive', path: '/archive' },
  { id: 'boards', label: 'Boards', path: '/leaderboards' },
  { id: 'rooms', label: 'Rooms', path: '/rooms' },
  { id: 'you', label: 'You', path: null },
] as const;
export type TabId = (typeof TABS)[number]['id'];

/** Submit, Queue, Claims and Settings: the You sheet on mobile, the avatar menu from tablet up. */
export const YOU_LINKS = [
  { id: 'submit', label: 'Submit', path: '/submit' },
  { id: 'queue', label: 'Queue', path: '/queue' },
  { id: 'claims', label: 'Claims', path: '/claims' },
  { id: 'settings', label: 'Settings', path: '/settings' },
] as const;
