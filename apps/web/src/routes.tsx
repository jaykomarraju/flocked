// The web route table (plan.md 2.5: a registry file, D-owned after wave 8). Routes follow the spec's
// "Client app" table; screens later waves build are placeholders until then. /__sheets (the design
// sheets the `ui` screenshot tests compare with the Paper exports) exists outside production builds.
import type { RouteObject } from 'react-router';
import { AppShell } from './layout/AppShell';
import { RouteError } from './layout/RouteError';
import { NotFound, Placeholder } from './screens/Placeholder';
import { Today } from './screens/Today';

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

const sheetRoutes: RouteObject[] =
  import.meta.env.MODE === 'production'
    ? []
    : [
        {
          path: '/__sheets',
          lazy: async () => ({ Component: (await import('./sheets/SheetPage')).SheetIndex }),
        },
        {
          path: '/__sheets/:surface/:screen/:state/:breakpoint',
          lazy: async () => ({ Component: (await import('./sheets/SheetPage')).SheetPage }),
        },
      ];

export const routes: RouteObject[] = [
  ...sheetRoutes,
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Today /> },
      { path: 'archive', element: <Placeholder tab="archive" title="Archive" /> },
      { path: 'leaderboards', element: <Placeholder tab="boards" title="Boards" /> },
      { path: 'rooms', element: <Placeholder tab="rooms" title="Rooms" /> },
      { path: 'rooms/:id', element: <Placeholder tab="rooms" title="Room" /> },
      { path: 'submit', element: <Placeholder tab="you" title="Submit a question" /> },
      { path: 'queue', element: <Placeholder tab="you" title="Queue" /> },
      { path: 'claims', element: <Placeholder tab="you" title="Claims" /> },
      { path: 'settings', element: <Placeholder tab="you" title="Settings" /> },
      { path: 'u/:handle', element: <Placeholder tab={null} title="Profile" /> },
      { path: 'r/:id', element: <Placeholder tab={null} title="Round" /> },
      { path: 'r/:id/verify', element: <Placeholder tab={null} title="Verify" /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
