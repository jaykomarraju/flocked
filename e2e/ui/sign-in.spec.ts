// Sign-in (W8-C; spec "Identity and personhood" › Identities): the sign-in artboards against their
// Paper exports, then sign-in end to end on the local stack, where the app, the API and the session
// cookie share one origin: SIWE with a test EIP-1193 wallet (a fresh key, announced over EIP-6963),
// and an email code read from the stack's email log, each with axe on the open dialog.
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LOG_DIR } from '../stack/env.mjs';
import { expect, poll, test, type Stack } from '../fixtures';
import { expectArtboard } from '../fixtures/screenshot';
import { TURNSTILE_TOKEN } from '../fixtures/user';

const STATES = ['browser', 'email-code', 'mini-app'] as const;
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

test.describe('sign-in sheets match Paper', () => {
  for (const state of STATES) {
    for (const breakpoint of BREAKPOINTS) {
      const artboard = `core/sign-in/${state}/${breakpoint}`;
      test(artboard, { tag: '@screenshot' }, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

// --- On the stack ------------------------------------------------------------------------------

/** Where `wrangler dev` logs each email the send_email binding sends (To:, then Subject:). */
const WRANGLER_LOG = join(LOG_DIR, 'wrangler.log');

/** A browser IP of its own (CF-Connecting-IP), apart from the `user` fixture's API-side players. */
const BROWSER_IP_PREFIX = `10.88.${randomInt(0, 250)}`;
let browserIps = 0;
function nextBrowserIp(): string {
  browserIps += 1;
  return `${BROWSER_IP_PREFIX}.${(browserIps % 250) + 1}`;
}

/** The log's size now: codes sent after this offset are the new ones. */
function logOffset(): number {
  try {
    return statSync(WRANGLER_LOG).size;
  } catch {
    return 0;
  }
}

/** An ANSI colour sequence (ESC [ … m). */
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The newest sign-in code sent to `email` after `offset` bytes of the log, or null. */
function codeInLog(email: string, offset: number): string | null {
  const text = readFileSync(WRANGLER_LOG)
    .subarray(offset)
    .toString('utf8')
    // Colour codes, if wrangler adds any.
    .replace(ANSI_COLOUR, '');
  let to: string | null = null;
  let code: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const toLine = /^\s*To:\s*<?([^\s<>]+)>?\s*$/.exec(line);
    if (toLine) {
      to = toLine[1]!.toLowerCase();
      continue;
    }
    const subject = /^\s*Subject:\s*(\d{8}) is your Flocked code\s*$/.exec(line);
    if (subject && to === email.toLowerCase()) code = subject[1]!;
  }
  return code;
}

/** Waits for the code the API sends to `email` after `offset`. */
function nextCode(email: string, offset: number): Promise<string> {
  return poll(`a code for ${email} in ${WRANGLER_LOG}`, 30_000, () =>
    Promise.resolve(codeInLog(email, offset)),
  );
}

/** A code that isn't `code`: its first digit moved on by one. */
function wrongCode(code: string): string {
  return `${(Number(code[0]) + 1) % 10}${code.slice(1)}`;
}

/**
 * The browser's setup: its own client IP, onboarding already seen, and Turnstile's script stubbed to
 * hand back the dummy token the stack's siteverify mock accepts.
 */
async function prepare(page: Page): Promise<void> {
  await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': nextBrowserIp() });
  await page.addInitScript(() => {
    try {
      (
        globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }
      ).localStorage.setItem('flocked.onboarded', '1');
    } catch {
      // Storage blocked: the onboarding modal would show; the test closes nothing for it.
    }
  });
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body:
        'window.turnstile = { render(el, o) { setTimeout(() => o.callback(' +
        JSON.stringify(TURNSTILE_TOKEN) +
        ')); return "w"; }, remove() {} };',
    }),
  );
}

/**
 * A test EIP-1193 wallet in the page: `window.ethereum`, also announced over EIP-6963, answering for
 * one fresh key that signs in Node (exposed as `__flockedTestSign`).
 */
async function installWallet(page: Page): Promise<string> {
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

/** Opens the sign-in dialog from the header's "Sign in". */
async function openSignIn(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // The dialog is named by its current step's title, so it is found by role and checked by name once.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Sign in to Flocked');
  return dialog;
}

/** No serious or critical axe violations inside the open dialog. */
async function expectAccessibleDialog(page: Page): Promise<void> {
  // After the open transition: mid-fade colours read as low contrast.
  await page.waitForFunction('document.getAnimations().every((a) => a.playState !== "running")');
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

/** Signed in: the dialog closed, the header's "Sign in" gone, and `GET /me` answers the cookie. */
async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Account menu|Your account)$/ })).toBeVisible();
  const me = await page.request.get('/api/v1/me');
  expect(me.status()).toBe(200);
}

/** Links a verified email to the player through the API, with the code from the log. */
async function linkEmail(stack: Stack, who: { token: string; ip: string }, email: string) {
  const offset = logOffset();
  const added = await stack.api('/me/email', { body: { email }, ...who });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const code = await nextCode(email, offset);
  const verified = await stack.api('/me/email/verify', { body: { email, code }, ...who });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
}

test.describe('sign-in on the stack', () => {
  test('a wallet signs in with SIWE (a new account), with axe on the dialog', async ({ page }) => {
    await prepare(page);
    await installWallet(page);
    const dialog = await openSignIn(page);
    await expect(dialog.getByRole('button', { name: 'Continue with Farcaster' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Email me a code' })).toBeVisible();
    await expectAccessibleDialog(page);

    await dialog.getByRole('button', { name: 'Connect a wallet' }).click();
    await expectSignedIn(page);
  });

  test('an email code signs in to the account it is linked to', async ({ page, stack, user }) => {
    const player = await user();
    const email = `e2e-${randomUUID().slice(0, 12)}@flocked.test`;
    await linkEmail(stack, player, email);

    await prepare(page);
    const dialog = await openSignIn(page);
    await dialog.getByRole('button', { name: 'Email me a code' }).click();
    await expect(dialog.getByRole('heading', { name: 'Sign in with email' })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Email' }).fill(email);
    const offset = logOffset();
    await dialog.getByRole('button', { name: 'Email me a code' }).click();

    await expect(dialog.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const codeField = dialog.getByRole('textbox', { name: 'Code' });
    await expect(codeField).toBeFocused();
    const code = await nextCode(email, offset);
    await expectAccessibleDialog(page);

    // A wrong code: the API's message, and the code stays for fixing.
    const wrong = wrongCode(code);
    await codeField.fill(wrong);
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(/Wrong code; \d attempts? left/);
    await expect(codeField).toHaveValue(wrong);

    await codeField.fill(code);
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expectSignedIn(page);
    const me = (await (await page.request.get('/api/v1/me')).json()) as { user: { id: string } };
    expect(me.user.id).toBe(player.userId);
  });
});
