// Wallets through wagmi (plan.md 4.2): an injected wallet when the browser has one (EIP-6963
// announcements first, then window.ethereum), otherwise Coinbase Smart Wallet, now Base Account
// (`baseAccount`). Inside the mini app the Farcaster client's own wallet is the injected one.
import { createConfig, http, type Config, type Connector } from 'wagmi';
import { connect, getConnectors, signMessage } from 'wagmi/actions';
import { baseAccount } from 'wagmi/connectors/baseAccount';
import { injected } from 'wagmi/connectors/injected';
import type { Address, EIP1193Provider, Hex } from 'viem';
import { appChain } from './config';

/** A connected wallet, enough to sign a SIWE message. */
export interface WalletSigner {
  address: Address;
  signMessage: (message: string) => Promise<Hex>;
}

export function createWagmiConfig(miniAppProvider?: EIP1193Provider): Config {
  const chain = appChain();
  return createConfig({
    chains: [chain],
    transports: { [chain.id]: http() },
    multiInjectedProviderDiscovery: !miniAppProvider,
    connectors: miniAppProvider
      ? [
          injected({
            target: () => ({ id: 'farcaster', name: 'Farcaster', provider: miniAppProvider }),
          }),
        ]
      : [injected(), baseAccount({ appName: 'Flocked' })],
  });
}

/** The connector "Connect a wallet" uses: a discovered or injected wallet, else the smart wallet. */
export async function pickConnector(config: Config): Promise<Connector> {
  const connectors = getConnectors(config);
  for (const c of connectors) {
    if (c.type !== 'injected') continue;
    if (await c.getProvider().then(Boolean, () => false)) return c;
  }
  const smart = connectors.find((c) => c.type === 'baseAccount');
  if (!smart) throw new Error('No wallet connector');
  return smart;
}

/** Connects (asking the wallet for its account) and returns a signer for that account. */
export async function connectWallet(config: Config): Promise<WalletSigner> {
  const connector = await pickConnector(config);
  const result = await connect(config, { connector });
  const address = result.accounts[0];
  if (!address) throw new Error('The wallet shared no account');
  return {
    address,
    signMessage: (message) => signMessage(config, { account: address, connector, message }),
  };
}
