// The wallet a Stakes entry or a claim is sent from (spec "Smart contract" › Gas and UX: a Coinbase
// Smart Wallet with a paymaster, so the player pays no ETH). It is the session's own wagmi config —
// the one sign-in connected with — so a signed-in player does not connect twice, and a claim made
// without an account connects the wallet on its own.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { getAccount, watchAccount } from 'wagmi/actions';
import { connectWallet } from '../auth/wallet';
import { useAuth } from '../auth/session';

export interface SmartWallet {
  config: ReturnType<typeof useAuth>['wagmiConfig'];
  /** The connected account, or null until one is. */
  address: Address | null;
  /** Asks the wallet for an account (a no-op once one is connected). */
  connect: () => Promise<Address>;
  connecting: boolean;
}

export function useSmartWallet(): SmartWallet {
  const { wagmiConfig } = useAuth();
  const [address, setAddress] = useState<Address | null>(
    () => getAccount(wagmiConfig).address ?? null,
  );
  const [connecting, setConnecting] = useState(false);

  // wagmi owns the connection: sign-in, a reconnect and a wallet-side account switch all land here.
  useEffect(
    () =>
      watchAccount(wagmiConfig, {
        onChange: (account) => setAddress(account.address ?? null),
      }),
    [wagmiConfig],
  );

  const connect = useCallback(async () => {
    const current = getAccount(wagmiConfig).address;
    if (current) return current;
    setConnecting(true);
    try {
      const wallet = await connectWallet(wagmiConfig);
      setAddress(wallet.address);
      return wallet.address;
    } finally {
      setConnecting(false);
    }
  }, [wagmiConfig]);

  return { config: wagmiConfig, address, connect, connecting };
}
