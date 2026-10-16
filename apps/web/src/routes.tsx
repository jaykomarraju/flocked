// The web route table (plan.md 2.5: a registry file, D-owned after wave 8). Routes follow the spec's
// "Client app" table; screens later waves build are placeholders until then, and the shell derives
// the active tab from the path. /__sheets (the design sheets the `ui` screenshot tests compare with
// the Paper exports) exists outside production builds.
import type { RouteObject } from 'react-router';
import { AppShell } from './layout/AppShell';
import { RouteError } from './layout/RouteError';
import { NotFound, Placeholder } from './screens/Placeholder';
import { Today } from './screens/Today';

export { TABS, YOU_LINKS, type TabId } from './nav';

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
    // The shell itself failed: the error box is the whole page.
    errorElement: <RouteError standalone />,
    children: [
      {
        // A screen failed: the error box takes its place inside the shell.
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Today /> },
          { path: 'archive', element: <Placeholder title="Archive" /> },
          { path: 'leaderboards', element: <Placeholder title="Boards" /> },
          { path: 'rooms', element: <Placeholder title="Rooms" /> },
          { path: 'rooms/:id', element: <Placeholder title="Room" /> },
          { path: 'submit', element: <Placeholder title="Submit a question" /> },
          { path: 'queue', element: <Placeholder title="Queue" /> },
          { path: 'claims', element: <Placeholder title="Claims" /> },
          { path: 'settings', element: <Placeholder title="Settings" /> },
          { path: 'u/:handle', element: <Placeholder title="Profile" /> },
          { path: 'r/:id', element: <Placeholder title="Round" /> },
          { path: 'r/:id/verify', element: <Placeholder title="Verify" /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];
