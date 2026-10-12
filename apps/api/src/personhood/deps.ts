// External services personhood depends on: Coinbase's OAuth and v2 API (one `fetch`) and the
// attestation network's RPC (Coinbase's indexer and EAS). `personhoodDeps(env)` builds the real
// ones; tests register fakes for one env object with `withPersonhoodDeps`, so production never
// falls back to a fake (plan 2.6). Same pattern as src/auth/deps.ts.
import { createClient, custom, fallback, http, type Client } from 'viem';
import { attestationRpcUrls, type PersonhoodEnv } from './config.js';

export interface PersonhoodDeps {
  /** `fetch` for login.coinbase.com and api.coinbase.com (or the local mock). */
  coinbaseFetch: typeof fetch;
  /** RPC client for the attestation network (Base, or the local EAS mock). */
  attestationRpc: Client;
}

const overrides = new WeakMap<object, Partial<PersonhoodDeps>>();

/**
 * Test hook: registers fake personhood dependencies for this env object and returns it (the rest
 * stay real). It registers in place rather than copying, so it composes with src/auth/deps.ts's
 * `withAuthDeps` copy (pass a per-test env, such as the one test/auth/fixtures.ts `authEnv` makes).
 */
export function withPersonhoodDeps<E extends PersonhoodEnv>(
  env: E,
  deps: Partial<PersonhoodDeps>,
): E {
  overrides.set(env, { ...overrides.get(env), ...deps });
  return env;
}

/** No RPC configured: every lookup rejects, so attestation checks fail closed. */
const noRpc = custom({
  request: () => Promise.reject(new Error('no attestation RPC configured (ATTESTATION_RPC_URL)')),
});

const rpcClients = new Map<string, Client>();

function attestationClient(env: PersonhoodEnv): Client {
  const urls = attestationRpcUrls(env);
  const key = urls.join(' ');
  let client = rpcClients.get(key);
  if (!client) {
    const transport = urls.length === 0 ? noRpc : fallback(urls.map((u) => http(u)));
    client = createClient({ transport });
    rpcClients.set(key, client);
  }
  return client;
}

export function personhoodDeps(env: PersonhoodEnv): PersonhoodDeps {
  const o = overrides.get(env) ?? {};
  return {
    coinbaseFetch: o.coinbaseFetch ?? ((input, init) => fetch(input, init)),
    attestationRpc: o.attestationRpc ?? attestationClient(env),
  };
}
