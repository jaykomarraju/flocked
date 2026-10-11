#!/usr/bin/env node
// `pnpm stack:status`: what the stack is and whether each part answers. Exits 1 when the stack is
// down or any part is unhealthy, so scripts can gate on it.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CRON_HEARTBEAT_FILE } from './cron.mjs';
import { alive, getJson, readDevVars, readState, rpc } from './env.mjs';

async function probe(fn) {
  try {
    return { ok: true, detail: await fn() };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

/** Probes every part of the stack. `failing` names the parts that did not answer as expected. */
export async function health(state) {
  const checks = {
    drand: probe(async () => {
      const info = await getJson(`${state.drand.url}/info`);
      if (info.hash !== state.drand.chainHash) throw new Error('a different chain is running');
      const latest = await getJson(`${state.drand.url}/public/latest`);
      return `round ${latest.round}, chain ${info.hash.slice(0, 12)}…`;
    }),
    anvil: probe(async () => {
      if (!alive(state.pids?.anvil)) throw new Error('process not running');
      const code = await rpc(state.anvil.rpcUrl, 'eth_getCode', [state.contracts.anchor, 'latest']);
      if (code === '0x') throw new Error('FlockedAnchor has no code');
      return `block ${Number(await rpc(state.anvil.rpcUrl, 'eth_blockNumber'))}`;
    }),
    api: probe(async () => {
      if (!alive(state.pids?.wrangler)) throw new Error('wrangler dev not running');
      if (!readDevVars()) throw new Error('.dev.vars is missing');
      const res = await fetch(`${state.apiUrl}/api/v1/me`, { signal: AbortSignal.timeout(5_000) });
      if (res.status !== 401) throw new Error(`GET /api/v1/me answered ${res.status}`);
      return state.apiUrl;
    }),
    farcaster: probe(async () => {
      if (!alive(state.pids?.farcaster)) throw new Error('process not running');
      await getJson(`${state.farcasterUrl}/health`);
      return state.farcasterUrl;
    }),
    cron: probe(() => {
      if (!alive(state.pids?.cron)) throw new Error('process not running');
      if (!existsSync(CRON_HEARTBEAT_FILE)) throw new Error('no pass yet');
      const beat = JSON.parse(readFileSync(CRON_HEARTBEAT_FILE, 'utf8'));
      const age = Date.now() - beat.at;
      // A pass can wait on receipts, so a few missed intervals are fine.
      if (age > beat.intervalMs * 3 + 60_000)
        throw new Error(`last pass ${Math.round(age / 1000)} s ago`);
      const failed = beat.results.filter((r) => !r.ok).map((r) => r.cron);
      return `every ${beat.intervalMs / 1000} s${failed.length ? `, last pass failed: ${failed.join(', ')}` : ''}`;
    }),
  };
  const results = Object.fromEntries(
    await Promise.all(Object.entries(checks).map(async ([k, p]) => [k, await p])),
  );
  const failing = Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([k]) => k);
  if (!state.ready) failing.unshift('startup incomplete');
  return { ok: failing.length === 0, results, failing };
}

export function printStatus(state, h) {
  const rows = [
    ['drand', h.results.drand],
    ['anvil', h.results.anvil],
    ['api', h.results.api],
    ['farcaster', h.results.farcaster],
    ['cron', h.results.cron],
  ];
  for (const [name, r] of rows)
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(10)} ${r.detail}`);
  if (state.contracts) {
    console.log(`  anchor ${state.contracts.anchor}, escrow ${state.contracts.escrow}`);
    console.log(`  receipt signer ${state.addresses.receiptSigner}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = readState();
  if (!state) {
    console.log('stack is down');
    process.exit(1);
  }
  const h = await health(state);
  console.log(
    `stack started ${state.startedAt}${h.ok ? '' : ` (failing: ${h.failing.join(', ')})`}`,
  );
  printStatus(state, h);
  process.exitCode = h.ok ? 0 : 1;
}
