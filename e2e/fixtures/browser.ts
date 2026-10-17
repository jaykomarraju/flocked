// A browser player on the stack (W9-C's "a Free round in the browser on the stack", moved here by
// W9-D.2 for `ui/today.spec.ts` and `ui/free-round.spec.ts`): its own client IP, onboarding already
// seen, Turnstile's script stubbed to hand back the dummy token the stack's siteverify mock accepts,
// and the stack's trusted chain (`window.__FLOCKED_LOCAL_CHAIN__`, apps/web/src/crypto/chain.ts) with
// `skipDailyClose`, since the stack's rounds close a minute out, not at 21:00 New York. It signs in
// with SIWE: through the sign-in dialog with a test EIP-1193 wallet (as `ui/sign-in.spec.ts` does),
// or by cookie through the API.
import { randomInt } from 'node:crypto';
import {
  AuthSessionResponseSchema,
  RoundMeResponseSchema,
  SiweNonceResponseSchema,
  type RoundMeResponse,
} from '@flocked/shared';
import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { Stack } from './stack';
import { TURNSTILE_TOKEN } from './user';

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
 */
export async function newPlayerPage(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const use = testInfo.project.use;
  const context = await browser.newContext({
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
