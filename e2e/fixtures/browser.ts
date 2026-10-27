// A browser player on the stack (W9-C's "a Free round in the browser on the stack", moved here by
// W9-D.2 for `ui/today.spec.ts` and `ui/free-round.spec.ts`): its own client IP, onboarding already
// seen, Turnstile's script stubbed to hand back the dummy token the stack's siteverify mock accepts,
// and the stack's trusted chain (`window.__FLOCKED_LOCAL_CHAIN__`, apps/web/src/crypto/chain.ts) with
// `skipDailyClose`, since the stack's rounds close a minute out, not at 21:00 New York. It signs in
// with SIWE: through the sign-in dialog with a test EIP-1193 wallet (as `ui/sign-in.spec.ts` does),
// or by cookie through the API.
//
// A Stakes player (W10-D.2) signs in with a Coinbase Smart Wallet stand-in instead
// (`installSmartWallet`): the app's EIP-5792 batches go through its real paymaster proxy and land on
// anvil. It verifies personhood in the tab (`verifyInBrowser`) through the stack's Coinbase mock.
import { randomInt, randomUUID } from 'node:crypto';
import {
  AuthSessionResponseSchema,
  MeResponseSchema,
  PaymasterResponseSchema,
  RoundMeResponseSchema,
  SiweNonceResponseSchema,
  type PaymasterResponse,
  type RoundMeResponse,
} from '@flocked/shared';
import {
  expect,
  type Browser,
  type BrowserContextOptions,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { getAddress, toHex, type Address, type Hex, type TransactionReceipt } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { http } from './http';
import { poll, type Stack } from './stack';
import { TURNSTILE_TOKEN } from './user';
import {
  newWallet,
  paymasterRequest,
  smartWalletUserOperation,
  walletFromKey,
  type Wallet,
} from './wallet';

/**
 * The verification copy (apps/web/src/features/stakes/copy.ts `VERIFY_CALLOUT`, `VERIFY_CTA`,
 * `VERIFY_SHEET`, `ageCheckboxLabel`): W10-C's stable browser handles. Copied, as the other specs
 * do, because the module's type imports reach Vite-only code e2e's tsconfig doesn't check.
 */
export const VERIFY = {
  calloutTitle: 'Stakes needs a verified account',
  cta: 'Verify with Coinbase',
  sheetTitle: 'Stakes needs a verified account',
  terms: 'I accept the Stakes terms',
  age: (age: number) => `I'm ${age} or older`,
} as const;

/** A browser IP block of its own (CF-Connecting-IP), apart from the `user` fixture's players. */
const BROWSER_IP_PREFIX = `10.77.${randomInt(0, 250)}`;
let browserIps = 0;
function nextBrowserIp(): string {
  browserIps += 1;
  return `${BROWSER_IP_PREFIX}.${(browserIps % 250) + 1}`;
}

/** The page's setup on the stack; call before `page.goto`. */
export async function preparePage(page: Page, stack: Stack): Promise<void> {
  await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': nextBrowserIp() });
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback(${JSON.stringify(TURNSTILE_TOKEN)})); return "w"; }, remove() {} };`,
    }),
  );
  // The Coinbase Wallet SDK in the app's wagmi config reports telemetry to Coinbase from every page
  // (W10-D.2 open issue); a test browser sends nothing off the stack.
  await page.route('https://cca-lite.coinbase.com/**', (route) => route.abort());
  await page.addInitScript(
    (local) => {
      const g = globalThis as unknown as {
        __FLOCKED_LOCAL_CHAIN__?: unknown;
        localStorage: { setItem(k: string, v: string): void };
      };
      g.__FLOCKED_LOCAL_CHAIN__ = local;
      g.localStorage.setItem('flocked.onboarded', '1');
    },
    {
      rpcUrl: stack.rpcUrl,
      anchor: stack.contracts.anchor,
      // The Stakes round config check and `enter` read these (W10-C, apps/web/src/crypto/chain.ts).
      escrow: stack.contracts.escrow,
      usdc: stack.contracts.usdc,
      drand: stack.drandChain,
      skipDailyClose: true,
    },
  );
}

/**
 * Another player's page: a browser context of its own (cookies, storage, IP), with the project's
 * device, locale and time zone, which `browser.newContext()` doesn't take from the config.
 * `storageState` reopens a player a spec's `ui` phase saved (its session cookie and device storage).
 */
export async function newPlayerPage(
  browser: Browser,
  testInfo: TestInfo,
  storageState?: BrowserContextOptions['storageState'],
): Promise<Page> {
  const use = testInfo.project.use;
  const context = await browser.newContext({
    ...(storageState ? { storageState } : {}),
    baseURL: use.baseURL,
    viewport: use.viewport,
    deviceScaleFactor: use.deviceScaleFactor,
    userAgent: use.userAgent,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    colorScheme: use.colorScheme,
    locale: use.locale,
    timezoneId: use.timezoneId,
  });
  return context.newPage();
}

/**
 * A test EIP-1193 wallet in the page: `window.ethereum`, also announced over EIP-6963, answering for
 * one fresh key that signs in Node (exposed as `__flockedTestSign`). Its address.
 */
export async function installWallet(page: Page): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());
  await page.exposeFunction('__flockedTestSign', (hex: string) =>
    account.signMessage({ message: { raw: hex as Hex } }),
  );
  await page.addInitScript(
    ({ address }) => {
      interface RequestArgs {
        method: string;
        params?: unknown[];
      }
      const g = globalThis as unknown as {
        ethereum?: unknown;
        __flockedTestSign: (hex: string) => Promise<string>;
        addEventListener: (type: string, fn: () => void) => void;
        dispatchEvent: (event: unknown) => boolean;
        CustomEvent: new (type: string, init: { detail: unknown }) => unknown;
        crypto: { randomUUID: () => string };
      };
      const rpcError = (code: number, message: string) =>
        Object.assign(new Error(message), { code });
      const provider = {
        isFlockedTest: true,
        request: async ({ method, params = [] }: RequestArgs): Promise<unknown> => {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [address];
            case 'eth_chainId':
              return '0x7a69';
            case 'net_version':
              return '31337';
            case 'personal_sign':
              return g.__flockedTestSign(params[0] as string);
            case 'wallet_switchEthereumChain':
              return null;
            case 'wallet_getPermissions':
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }];
            case 'wallet_revokePermissions':
              return null;
            default:
              throw rpcError(4200, `The test wallet does not support ${method}`);
          }
        },
        on: () => provider,
        removeListener: () => provider,
      };
      g.ethereum = provider;
      const detail = Object.freeze({
        info: {
          uuid: g.crypto.randomUUID(),
          name: 'Flocked test wallet',
          icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/%3E',
          rdns: 'test.flocked.wallet',
        },
        provider,
      });
      const announce = () =>
        g.dispatchEvent(new g.CustomEvent('eip6963:announceProvider', { detail }));
      g.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { address: account.address },
  );
  return account.address;
}

/**
 * Signs in a new account through the header's "Sign in" and "Connect a wallet" (SIWE with the page's
 * test wallet, `installWallet`), then checks the session cookie answers `GET /me`. The user's ID.
 */
export async function signInWithWallet(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Sign in to Flocked');
  await dialog.getByRole('button', { name: 'Connect a wallet' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^(Account menu|Your account)$/ })).toBeVisible();
  const me = await page.request.get('/api/v1/me');
  expect(me.status()).toBe(200);
  return ((await me.json()) as { user: { id: string } }).user.id;
}

/** Signs in a new account by SIWE through the API, so the page holds its session cookie. */
export async function signInByCookie(page: Page, stack: Stack): Promise<void> {
  const account = privateKeyToAccount(generatePrivateKey());
  const api = `${stack.appOrigin}/api/v1`;
  const nonce = SiweNonceResponseSchema.parse(
    await (await page.request.post(`${api}/auth/siwe/nonce`, { data: {} })).json(),
  );
  const origin = new URL(stack.appOrigin);
  const message = createSiweMessage({
    address: account.address,
    chainId: stack.chainId,
    domain: origin.host,
    nonce: nonce.nonce,
    uri: origin.origin,
    version: '1',
    issuedAt: new Date(),
  });
  const verify = await page.request.post(`${api}/auth/siwe/verify`, {
    data: {
      message,
      signature: await account.signMessage({ message }),
      turnstileToken: TURNSTILE_TOKEN,
    },
  });
  expect(verify.status()).toBe(200);
  AuthSessionResponseSchema.parse(await verify.json());
}

/** `GET /rounds/:id/me` with the page's session cookie. */
export async function pageRoundMe(page: Page, roundId: string): Promise<RoundMeResponse> {
  const res = await page.request.get(`/api/v1/rounds/${roundId}/me`);
  expect(res.status()).toBe(200);
  return RoundMeResponseSchema.parse(await res.json());
}

/** One `wallet_sendCalls` batch the smart-wallet stand-in got from the app. */
export interface SponsoredBatch {
  calls: { to: Address; data: Hex }[];
  /** `capabilities.paymasterService.url`: where the app sent the wallet for sponsorship. */
  paymasterUrl: string | null;
  /** The proxy's answers to `pm_getPaymasterStubData`, then `pm_getPaymasterData`. */
  sponsorship: PaymasterResponse[];
  /** The calls' transactions, in order, once included; none if the proxy refused the operation. */
  receipts: TransactionReceipt[];
}

/** A browser player's smart wallet: its key on the stack and the batches the app sent through it. */
export interface BrowserSmartWallet {
  wallet: Wallet;
  batches: SponsoredBatch[];
  /** Holds every batch sent from now on out of a block until the returned release is called. */
  hold(): () => void;
}

interface SendCallsRequest {
  from?: string;
  chainId?: string;
  calls: { to: string; data?: string; value?: string }[];
  capabilities?: { paymasterService?: { url?: string } };
}

/**
 * A Coinbase Smart Wallet stand-in for a Stakes player on the stack (W10-D.2; spec "Smart contract" ›
 * Gas and UX). It signs SIWE with a fresh test key (or `key`, a player a `ui` phase saved) and speaks
 * EIP-5792: for each `wallet_sendCalls` batch it builds the Coinbase Smart Wallet user operation
 * (`executeBatch` over the app's calls, EntryPoint v0.6, `fixtures/wallet.ts`) and asks the paymaster
 * service the app named in `capabilities.paymasterService.url` — the app's own `POST
 * /api/v1/paymaster` proxy, which checks the calls and forwards to the stack's provider mock — for
 * stub and final sponsorship. Only a sponsored operation is sent; a refusal reaches the app as a
 * paymaster error. anvil has no EntryPoint or smart-wallet contract, so the stand-in then does what
 * `executeBatch` would: it sends the calls in order from the wallet's address (anvil's gas standing
 * in for the paymaster's) and reports their receipts through `wallet_getCallsStatus`, pending until
 * they are mined. Register it before `page.goto`.
 */
export async function installSmartWallet(
  page: Page,
  stack: Stack,
  key?: Hex,
): Promise<BrowserSmartWallet> {
  const wallet = key ? walletFromKey(stack, key) : await newWallet(stack);
  if (key) await stack.testClient.setBalance({ address: wallet.address, value: 10n ** 18n });
  const batches: SponsoredBatch[] = [];
  const included = new Map<string, { done: boolean; failed: boolean }>();
  let gate: Promise<void> = Promise.resolve();
  // EntryPoint nonces are a 192-bit key and a 64-bit sequence; a key per install keeps a reopened
  // player's operations apart from the ones its `ui` phase sent.
  const nonceKey = BigInt(randomInt(1, 2 ** 47)) << 64n;

  async function include(batch: SponsoredBatch, state: { done: boolean; failed: boolean }) {
    try {
      for (const call of batch.calls) {
        const hash = await wallet.client.sendTransaction({ to: call.to, data: call.data });
        // anvil mines each transaction as it arrives, so the receipt is there to read. Not
        // `waitForTransactionReceipt`: concurrent waiters share one block watcher, and anvil mines
        // no block after the last transaction for a late one to see.
        const receipt = await poll(`the receipt of ${hash}`, 60_000, () =>
          stack.client.getTransactionReceipt({ hash }).catch(() => null),
        );
        batch.receipts.push(receipt);
        if (receipt.status !== 'success') {
          state.failed = true;
          break;
        }
      }
    } catch {
      state.failed = true;
    } finally {
      state.done = true;
    }
  }

  await page.exposeFunction('__flockedSmartSign', (hex: string) =>
    wallet.account.signMessage({ message: { raw: hex as Hex } }),
  );
  await page.exposeFunction('__flockedSmartSendCalls', async (req: SendCallsRequest) => {
    if (req.from && req.from.toLowerCase() !== wallet.lower) {
      throw new Error(`The test smart wallet is ${wallet.address}, not ${req.from}`);
    }
    const batch: SponsoredBatch = {
      calls: req.calls.map((c) => ({ to: getAddress(c.to), data: (c.data ?? '0x') as Hex })),
      paymasterUrl: req.capabilities?.paymasterService?.url ?? null,
      sponsorship: [],
      receipts: [],
    };
    batches.push(batch);
    if (req.calls.some((c) => c.value && BigInt(c.value) !== 0n)) {
      throw new Error('The test smart wallet sends no ETH');
    }
    if (!batch.paymasterUrl)
      throw new Error('No paymaster: this wallet sends sponsored operations only');
    const op = smartWalletUserOperation(
      wallet.address,
      batch.calls,
      nonceKey + BigInt(batches.length - 1),
    );
    for (const [i, method] of (
      ['pm_getPaymasterStubData', 'pm_getPaymasterData'] as const
    ).entries()) {
      const res = await http(batch.paymasterUrl, {
        body: paymasterRequest(method, op, stack.chainId, i + 1),
        idempotent: true,
      });
      const answer = PaymasterResponseSchema.parse(res.body);
      batch.sponsorship.push(answer);
      if ('error' in answer) {
        throw new Error(`The paymaster rejected the operation: ${answer.error.message}`);
      }
      if (!answer.result.paymasterAndData && !answer.result.paymaster) {
        throw new Error('The paymaster answered no sponsorship for the operation');
      }
    }
    const id = `0x${(nonceKey + BigInt(batches.length)).toString(16).padStart(64, '0')}`;
    const state = { done: false, failed: false };
    included.set(id, state);
    const held = gate;
    void held.then(() => include(batch, state));
    return id;
  });
  await page.exposeFunction('__flockedSmartCallsStatus', (id: string) => {
    const state = included.get(id);
    const batch = batches[Number(BigInt(id) - nonceKey) - 1];
    if (!state || !batch) throw new Error(`The test smart wallet sent no batch ${id}`);
    return {
      version: '2.0.0',
      id,
      chainId: toHex(stack.chainId),
      atomic: true,
      status: !state.done ? 100 : state.failed ? 500 : 200,
      receipts: state.done
        ? batch.receipts.map((r) => ({
            status: r.status === 'success' ? '0x1' : '0x0',
            blockHash: r.blockHash,
            blockNumber: toHex(r.blockNumber),
            gasUsed: toHex(r.gasUsed),
            transactionHash: r.transactionHash,
            logs: r.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics })),
          }))
        : [],
    };
  });

  await page.addInitScript(
    ({ address, chainId }) => {
      interface RequestArgs {
        method: string;
        params?: unknown[];
      }
      const g = globalThis as unknown as {
        ethereum?: unknown;
        __flockedSmartSign: (hex: string) => Promise<string>;
        __flockedSmartSendCalls: (req: unknown) => Promise<string>;
        __flockedSmartCallsStatus: (id: string) => Promise<unknown>;
        addEventListener: (type: string, fn: () => void) => void;
        dispatchEvent: (event: unknown) => boolean;
        CustomEvent: new (type: string, init: { detail: unknown }) => unknown;
        crypto: { randomUUID: () => string };
      };
      const rpcError = (code: number, message: string) =>
        Object.assign(new Error(message), { code });
      const provider = {
        isFlockedTest: true,
        request: async ({ method, params = [] }: RequestArgs): Promise<unknown> => {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [address];
            case 'eth_chainId':
              return chainId;
            case 'net_version':
              return String(Number(chainId));
            case 'personal_sign':
              return g.__flockedSmartSign(params[0] as string);
            case 'wallet_switchEthereumChain':
              return null;
            case 'wallet_getPermissions':
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }];
            case 'wallet_revokePermissions':
              return null;
            case 'wallet_getCapabilities':
              return {
                [chainId]: {
                  atomic: { status: 'supported' },
                  paymasterService: { supported: true },
                },
              };
            case 'wallet_sendCalls':
              return { id: await g.__flockedSmartSendCalls(params[0]) };
            case 'wallet_getCallsStatus':
              return g.__flockedSmartCallsStatus(params[0] as string);
            default:
              throw rpcError(4200, `The test smart wallet does not support ${method}`);
          }
        },
        on: () => provider,
        removeListener: () => provider,
      };
      g.ethereum = provider;
      const detail = Object.freeze({
        info: {
          uuid: g.crypto.randomUUID(),
          name: 'Flocked test smart wallet',
          icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/%3E',
          rdns: 'test.flocked.smartwallet',
        },
        provider,
      });
      const announce = () =>
        g.dispatchEvent(new g.CustomEvent('eip6963:announceProvider', { detail }));
      g.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { address: wallet.address, chainId: toHex(stack.chainId) },
  );

  return {
    wallet,
    batches,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => release();
    },
  };
}

/**
 * Personhood in the tab (E2E-1 Stakes UI; spec "Client app" › Entry flow (Stakes) step 1): on Today
 * with a Stakes round on screen, the Stakes toggle, "Verify with Coinbase", the verification sheet's
 * age and terms, then Coinbase's OAuth flow through the stack's mock and the API's callback back to
 * the app (Settings), until `/me` says Stakes, and the nav back to Today. What it verifies against
 * is the player's world, not a shortcut: the player's own Coinbase account (a fresh mock account
 * each, since one person holds one Flocked account; chosen on the mock's authorize page, where the
 * player would sign in) and the wallet's Coinbase Verifications attestations (the EAS mock).
 */
export async function verifyInBrowser(page: Page, stack: Stack, wallet: Address): Promise<void> {
  const account = `e2e-browser-${randomUUID()}`;
  const made = await http(`${stack.coinbaseUrl}/mock/users`, {
    body: { key: account, country: 'US', state: 'TX' },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const attested = await http(`${stack.easUrl}/mock/verify`, {
    body: { recipient: wallet.toLowerCase(), country: 'US' },
  });
  expect(attested.status, JSON.stringify(attested.body)).toBe(200);
  await page.route(`${stack.coinbaseUrl}/oauth2/auth?*`, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('mock_user', account);
    return route.continue({ url: url.toString() });
  });

  await page.getByRole('radio', { name: 'Stakes' }).click();
  await expect(page.getByText(VERIFY.calloutTitle)).toBeVisible();
  await page.getByRole('button', { name: VERIFY.cta }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(VERIFY.sheetTitle)).toBeVisible();
  const me = MeResponseSchema.parse(await (await page.request.get('/api/v1/me')).json());
  await sheet.getByRole('checkbox', { name: VERIFY.age(me.tos.ageRequired) }).check();
  await sheet.getByRole('checkbox', { name: VERIFY.terms }).check();
  const callback = page.waitForResponse((r) => r.url().includes('/me/personhood/callback'));
  await sheet.getByRole('button', { name: VERIFY.cta }).click();
  // Coinbase approves and sends the tab to the API's callback, which redirects back to the app.
  const back = await callback;
  expect(back.status()).toBe(302);
  const landing = new URL(back.headers().location ?? '', stack.appOrigin);
  expect(landing.searchParams.get('personhood')).toBe('verified');
  // The callback always lands on Settings (`personhoodReturnUrl`, W5-B), wherever the flow began, and
  // Settings is a placeholder until W12; the player takes the nav back to Today (W10-D.2 spec issue).
  expect(landing.pathname).toBe('/settings');
  await page.waitForURL((url) => url.pathname === '/settings');
  const after = MeResponseSchema.parse(await (await page.request.get('/api/v1/me')).json());
  expect(after.stakes).toEqual({ eligible: true, reasons: [] });
  expect(after.tos.acceptedVersion).toBe(stack.tosVersion);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Today' }).click();
  await page.waitForURL((url) => url.pathname === '/');
}

/** A Reveal phase (`[data-phase]`) or result card (`section[data-result]`) a page drew. */
export interface RevealSeen {
  phase: string;
  result: string | null;
  at: number;
  /** The text it was first drawn with. */
  text: string;
}

/**
 * Records every Reveal phase and result card the page draws, from the first document on (the shape
 * of `ui/free-round.spec.ts`'s recorder, with the result card too: a Stakes card turns refunded when
 * the guardian vetoes, in the same phase or the next). Phases on the stack can last a second, so they
 * are recorded in the page, not polled for.
 */
export async function recordReveal(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface El {
      getAttribute(n: string): string | null;
      textContent: string | null;
    }
    const g = globalThis as unknown as {
      __flockedReveal?: RevealSeen[];
      document: { querySelector(s: string): El | null };
      MutationObserver: new (cb: () => void) => { observe(n: unknown, o: unknown): void };
    };
    const seen: RevealSeen[] = [];
    g.__flockedReveal = seen;
    let last = '';
    const note = () => {
      const el = g.document.querySelector('[data-phase]');
      const card = g.document.querySelector('section[data-result]');
      const phase = el?.getAttribute('data-phase') ?? 'none';
      const result = card?.getAttribute('data-result') ?? null;
      if (`${phase}/${result}` === last) return;
      last = `${phase}/${result}`;
      seen.push({
        phase,
        result,
        at: Date.now(),
        text: (el ?? g.document.querySelector('main'))?.textContent?.slice(0, 400) ?? '',
      });
    };
    new g.MutationObserver(note).observe(g.document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-phase', 'data-result'],
    });
  });
}

/** What `recordReveal` saw, from the first Reveal phase on. */
export async function revealSeen(page: Page): Promise<RevealSeen[]> {
  const seen = await page.evaluate(
    () => (globalThis as unknown as { __flockedReveal?: RevealSeen[] }).__flockedReveal ?? [],
  );
  const first = seen.findIndex((s) => s.phase !== 'none');
  return first < 0 ? [] : seen.slice(first);
}

/** A moment as the app's clock-time copy writes it ("11:03pm"), in the project's time zone. */
export function clockTime(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  })
    .format(new Date(epochMs))
    .replace(/\s?([AP])M$/i, (_, p: string) => `${p.toLowerCase()}m`);
}
