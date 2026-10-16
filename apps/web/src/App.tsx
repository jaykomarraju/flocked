// Providers, outermost first: wagmi (wallets), react-query (wagmi needs it; screens use it for API
// reads), the session, then the router. The mini app context is detected once at start (main.tsx).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import type { EIP1193Provider } from 'viem';
import { WagmiProvider } from 'wagmi';
import type { MiniApp } from './auth/miniapp';
import { AuthProvider } from './auth/session';
import { createWagmiConfig } from './auth/wallet';
import { routes } from './routes';

const router = createBrowserRouter(routes);

export function App({
  miniApp = null,
  miniAppWallet,
}: {
  miniApp?: MiniApp | null;
  miniAppWallet?: EIP1193Provider;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );
  const wagmiConfig = useMemo(() => createWagmiConfig(miniAppWallet), [miniAppWallet]);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider wagmiConfig={wagmiConfig} miniApp={miniApp}>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
