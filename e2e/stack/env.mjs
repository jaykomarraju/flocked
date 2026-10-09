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
export const CONTRACTS_DIR = join(ROOT, 'contracts');
export const COMPOSE_FILE = join(STACK_DIR, 'docker-compose.yml');
export const STATE_FILE = join(STACK_DIR, '.state.json');
export const DEV_VARS_FILE = join(STACK_DIR, '.dev.vars');
/** Logs and wrangler's local persistence (D1, KV, DO storage). */
export const RUN_DIR = join(STACK_DIR, '.run');
export const LOG_DIR = join(RUN_DIR, 'logs');
export const PERSIST_DIR = join(RUN_DIR, 'wrangler');
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
  inspector: port('STACK_INSPECTOR_PORT', 19229),
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
/** Turnstile's documented always-pass test secret; its siteverify accepts any token. */
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';
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

/** Parses `.dev.vars` (dotenv: KEY=value, values optionally single-quoted). */
export function readDevVars() {
  if (!existsSync(DEV_VARS_FILE)) return null;
  const vars = {};
  for (const line of readFileSync(DEV_VARS_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    vars[m[1]] = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return vars;
}

/** Writes `.dev.vars` (mode 0600). Values are single-quoted, so JSON survives dotenv parsing. */
export function writeDevVars(vars) {
  const lines = [
    '# Written by `pnpm stack:up` (e2e/stack/up.mjs); regenerated with fresh keys on every run.',
    '# Local only, gitignored. `wrangler dev --env-file` loads it over wrangler.jsonc vars.',
    ...Object.entries(vars).map(([k, v]) => {
      const s = String(v);
      if (s.includes("'") || s.includes('\n')) throw new Error(`${k}: unsupported character`);
      return `${k}='${s}'`;
    }),
  ];
  writeFileSync(DEV_VARS_FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
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
