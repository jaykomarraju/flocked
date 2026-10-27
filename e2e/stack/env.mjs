// Shared paths, ports and files for the local stack scripts (up, down, status) and the e2e tests.
// Stack facts live in `.state.json` (public values only); the API's vars and secrets live in
// `.dev.vars`, which `wrangler dev` loads with `--env-file`. Both are gitignored and rewritten on
// every `pnpm stack:up`, with fresh keys.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STACK_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(STACK_DIR, '..', '..');
export const API_DIR = join(ROOT, 'apps', 'api');
export const SIGNER_DIR = join(ROOT, 'apps', 'signer');
export const WATCHER_DIR = join(ROOT, 'apps', 'watcher');
export const CONTRACTS_DIR = join(ROOT, 'contracts');
export const COMPOSE_FILE = join(STACK_DIR, 'docker-compose.yml');
export const STATE_FILE = join(STACK_DIR, '.state.json');
export const DEV_VARS_FILE = join(STACK_DIR, '.dev.vars');
/** Logs and wrangler's local persistence (D1, KV, DO storage). */
export const RUN_DIR = join(STACK_DIR, '.run');
export const LOG_DIR = join(RUN_DIR, 'logs');
export const PERSIST_DIR = join(RUN_DIR, 'wrangler');
/** The ticket signer's env (TICKET_SIGNER_KEY, LOCAL_DEPLOYMENT); never the API's (NFR-7). */
export const SIGNER_VARS_FILE = join(RUN_DIR, 'ticket-signer.dev.vars');
/** The signer's wrangler config as the stack runs it (a copy of apps/signer's; up.mjs). */
export const SIGNER_RUN_DIR = join(RUN_DIR, 'signer');
/** The independent watcher's generated local config and secrets (never shared with the API). */
export const WATCHER_RUN_DIR = join(RUN_DIR, 'watcher');
export const WATCHER_VARS_FILE = join(WATCHER_RUN_DIR, '.dev.vars');
export const WATCHER_PERSIST_DIR = join(RUN_DIR, 'watcher-wrangler');
/** Written by contracts/script/Deploy.s.sol on chain 31337 (gitignored). */
export const DEPLOYMENT_FILE = join(CONTRACTS_DIR, 'deployments', '31337.json');
/** `wrangler dev` needs the assets directory to exist; apps/web does not build into it yet. */
export const WEB_DIST_DIR = join(ROOT, 'apps', 'web', 'dist');

const port = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a TCP port`);
  return n;
};

/** Host ports, each overridable (`STACK_API_PORT=8788 pnpm stack:up`). */
export const PORTS = Object.freeze({
  api: port('STACK_API_PORT', 8787),
  anvil: port('STACK_ANVIL_PORT', 18545),
  drand: port('STACK_DRAND_PORT', 18080),
  farcaster: port('STACK_FARCASTER_PORT', 8789),
  coinbase: port('STACK_COINBASE_PORT', 8790),
  eas: port('STACK_EAS_PORT', 8791),
  turnstile: port('STACK_TURNSTILE_PORT', 8792),
  anthropic: port('STACK_ANTHROPIC_PORT', 8793),
  push: port('STACK_PUSH_PORT', 8794),
  farcasterNotify: port('STACK_FARCASTER_NOTIFY_PORT', 8795),
  email: port('STACK_EMAIL_PORT', 8796),
  bundler: port('STACK_BUNDLER_PORT', 8797),
  watcher: port('STACK_WATCHER_PORT', 8798),
  pager: port('STACK_PAGER_PORT', 8799),
  inspector: port('STACK_INSPECTOR_PORT', 19229),
  watcherInspector: port('STACK_WATCHER_INSPECTOR_PORT', 19230),
});

export const LOCAL_CHAIN_ID = 31337;
/** drand network shape (docker-compose.yml, drand/dkg.sh). */
export const DRAND = Object.freeze({
  scheme: 'bls-unchained-g1-rfc9380',
  period: 3,
  genesisDelay: 15,
  nodes: 3,
  threshold: 2,
});
/**
 * Turnstile's documented always-pass test secret; the stack's siteverify mock (e2e/mocks/turnstile)
 * accepts any token with it, as Cloudflare's does.
 */
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';
/**
 * The moderation mock's API key (e2e/mocks/anthropic checks only that one is sent). Not a secret: the
 * API sends it only to `ANTHROPIC_BASE_URL`, which is honoured only locally.
 */
export const ANTHROPIC_MOCK_KEY = 'mock-anthropic-key';
/**
 * The Farcaster notification mock's Neynar values (e2e/mocks/farcaster-notify; W9-A). Not secrets: the
 * daily cast goes to `FARCASTER_CAST_API_URL`, which is honoured only locally.
 */
export const NEYNAR_MOCK = Object.freeze({ apiKey: 'mock-neynar-key', signerUuid: 'mock-signer' });
export const TOS_VERSION = '2026-10-01';

export const rel = (p) => relative(ROOT, p);

/** The stack state, or null when the stack is not up. */
export function readState() {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

export function writeState(state) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/** Parses `.dev.vars` or another `writeDevVars` file (dotenv: KEY=value, optionally single-quoted). */
export function readDevVars(file = DEV_VARS_FILE) {
  if (!existsSync(file)) return null;
  const vars = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    vars[m[1]] = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return vars;
}

/**
 * Writes a dotenv file of vars and secrets (mode 0600): the API's `.dev.vars` by default. Values are
 * single-quoted, so JSON survives dotenv parsing.
 */
export function writeDevVars(vars, file = DEV_VARS_FILE) {
  const lines = [
    '# Written by `pnpm stack:up` (e2e/stack/up.mjs); regenerated with fresh keys on every run.',
    '# Local only, gitignored. `wrangler dev` loads it over wrangler.jsonc vars.',
    ...Object.entries(vars).map(([k, v]) => {
      const s = String(v);
      if (s.includes("'") || s.includes('\n')) throw new Error(`${k}: unsupported character`);
      return `${k}='${s}'`;
    }),
  ];
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

/** Parses JSON with comments and trailing commas (a wrangler.jsonc). */
export function parseJsonc(text) {
  const strip = (src, onChar) => {
    let out = '';
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
        out += src.slice(i, j + 1);
        i = j;
      } else {
        const skip = onChar(src, i);
        if (skip === undefined) out += c;
        else i = skip;
      }
    }
    return out;
  };
  // Comments first (a line comment keeps its newline), then commas before a closing bracket.
  const noComments = strip(text, (s, i) => {
    if (s[i] === '/' && s[i + 1] === '/') {
      const end = s.indexOf('\n', i);
      return (end === -1 ? s.length : end) - 1;
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated comment');
      return end + 1;
    }
    return undefined;
  });
  const noTrailingCommas = strip(noComments, (s, i) =>
    s[i] === ',' && /^\s*[}\]]/.test(s.slice(i + 1)) ? i : undefined,
  );
  return JSON.parse(noTrailingCommas);
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

export function removePath(p) {
  rmSync(p, { recursive: true, force: true });
}

/** True while `pid` is alive (signal 0 checks without killing). */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value or `timeoutMs` passes; then throws `what`. */
export async function waitFor(what, fn, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    }
    await sleep(intervalMs);
  }
}

/** GET a JSON document, or throw with the status. */
export async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** One JSON-RPC call to anvil. */
export async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
