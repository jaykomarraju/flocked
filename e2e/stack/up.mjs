#!/usr/bin/env node
// `pnpm stack:up`: the local stack (plan 4.4 `local`; e2e/stack/README.md).
//
//   1. a 3-node drand network in Docker (bls-unchained-g1-rfc9380, 3 s period) and its DKG;
//   2. anvil on chain 31337 (STACK_FORK_URL forks Base or any chain, keeping chain ID 31337);
//   3. the CREATE2 deploy (contracts/script/Deploy.s.sol) with the local drand genesis and period
//      and fresh role keys;
//   4. e2e/stack/.dev.vars (the drand chain, the deployment, fresh keys, the test seam key), the D1
//      migrations, and `wrangler dev --local` for apps/api, plus the Farcaster Quick Auth mock.
//
// Idempotent: a healthy stack is left alone; anything else is torn down and started fresh. Stack
// facts go to e2e/stack/.state.json, logs to e2e/stack/.run/logs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createPublicClient, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { down } from './down.mjs';
import {
  API_DIR,
  COMPOSE_FILE,
  CONTRACTS_DIR,
  DEPLOYMENT_FILE,
  DEV_VARS_FILE,
  DRAND,
  LOCAL_CHAIN_ID,
  LOG_DIR,
  PERSIST_DIR,
  PORTS,
  ROOT,
  STACK_DIR,
  TOS_VERSION,
  TURNSTILE_TEST_SECRET,
  WEB_DIST_DIR,
  alive,
  ensureDir,
  getJson,
  readState,
  rel,
  rpc,
  waitFor,
  writeDevVars,
  writeState,
} from './env.mjs';
import { health, printStatus } from './status.mjs';

const t0 = Date.now();
const log = (msg) => console.log(`[stack ${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const WRANGLER = join(API_DIR, 'node_modules', '.bin', 'wrangler');
const urls = {
  api: `http://127.0.0.1:${PORTS.api}`,
  appOrigin: `http://localhost:${PORTS.api}`,
  anvil: `http://127.0.0.1:${PORTS.anvil}`,
  drand: `http://127.0.0.1:${PORTS.drand}`,
  farcaster: `http://127.0.0.1:${PORTS.farcaster}`,
};

/** Runs a command to completion, output to `.run/logs/<name>.log`; rejects with the log's tail. */
function run(name, cmd, args, opts = {}) {
  const file = join(LOG_DIR, `${name}.log`);
  const fd = openSync(file, 'a');
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', fd, fd] });
    child.on('error', (err) => {
      closeSync(fd);
      reject(new Error(`${name}: ${err.message}`));
    });
    child.on('exit', (code) => {
      closeSync(fd);
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with ${code}:\n${tail(file)}`));
    });
  });
}

/** Runs a command and resolves with its stdout; rejects on a non-zero exit. */
function capture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with ${code}: ${err.trim()}`)),
    );
  });
}

/** Starts a long-running process in its own process group (so down can stop its children). */
function start(name, cmd, args, opts = {}) {
  const fd = openSync(join(LOG_DIR, `${name}.log`), 'a');
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.unref();
  if (!child.pid) throw new Error(`${name}: failed to start ${cmd}`);
  return child.pid;
}

function tail(file, lines = 40) {
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Waits for `check`, failing early (with the log) if the process `name` dies. */
function waitForProcess(name, pid, what, check, opts) {
  return waitFor(
    what,
    async () => {
      if (!alive(pid)) throw new Error(`${name} exited:\n${tail(join(LOG_DIR, `${name}.log`))}`);
      return check();
    },
    opts,
  );
}

async function preflight() {
  await run('preflight-docker', 'docker', ['info']).catch(() => {
    throw new Error('Docker is not available (OrbStack must be running: OA-01)');
  });
  for (const tool of ['anvil', 'forge']) {
    await run(`preflight-${tool}`, tool, ['--version']).catch(() => {
      throw new Error(`${tool} is not on PATH (Foundry 1.7.1)`);
    });
  }
  if (!existsSync(WRANGLER)) throw new Error('wrangler is missing: run `pnpm install` first');
  for (const [name, port] of Object.entries(PORTS)) {
    if (!(await portFree(port))) {
      throw new Error(
        `port ${port} (${name}) is in use; free it or set STACK_${name.toUpperCase()}_PORT`,
      );
    }
  }
}

/** Fresh keys for every role. Only the API's keys are written to .dev.vars; the rest are dropped. */
function freshKeys() {
  const roles = [
    'admin',
    'guardian',
    'operator',
    'pauser',
    'ticketSigner',
    'treasury',
    'anchorer',
    'receiptSigner',
  ];
  return Object.fromEntries(
    roles.map((role) => {
      const key = generatePrivateKey();
      return [role, { key, address: privateKeyToAccount(key).address }];
    }),
  );
}

async function deploy(keys, chain) {
  const [deployer] = await rpc(urls.anvil, 'eth_accounts');
  const env = { ...process.env };
  delete env.USDC; // anvil: Deploy.s.sol deploys MockUSDC
  delete env.DEPLOYMENTS_FILE;
  Object.assign(env, {
    ADMIN: keys.admin.address,
    GUARDIAN: keys.guardian.address,
    OPERATOR: keys.operator.address,
    PAUSER: keys.pauser.address,
    TICKET_SIGNER: keys.ticketSigner.address,
    TREASURY: keys.treasury.address,
    ANCHORER: keys.anchorer.address,
    RECEIPT_SIGNER: keys.receiptSigner.address,
    DRAND_GENESIS: String(chain.genesis),
    DRAND_PERIOD: String(chain.period),
  });
  await run(
    'deploy',
    'forge',
    [
      'script',
      'script/Deploy.s.sol',
      '--fork-url',
      urls.anvil,
      '--broadcast',
      '--unlocked',
      '--sender',
      deployer,
    ],
    { cwd: CONTRACTS_DIR, env },
  );
  const raw = readFileSync(DEPLOYMENT_FILE, 'utf8');
  const deployment = JSON.parse(raw);
  const client = createPublicClient({ transport: http(urls.anvil) });
  const signer = await client.readContract({
    address: deployment.anchor,
    abi: parseAbi(['function receiptSigner() view returns (address)']),
    functionName: 'receiptSigner',
  });
  if (signer.toLowerCase() !== keys.receiptSigner.address.toLowerCase()) {
    throw new Error(`FlockedAnchor.receiptSigner() is ${signer}, not the generated signer`);
  }
  // Gas for the keys the API will send transactions with (AnchorDO W4-A, operator W6-A).
  for (const role of ['anchorer', 'operator']) {
    await rpc(urls.anvil, 'anvil_setBalance', [keys[role].address, '0x56bc75e2d63100000']);
  }
  return { deployer, deployment, raw: JSON.stringify(deployment) };
}

async function main() {
  const existing = readState();
  if (existing) {
    const h = await health(existing);
    if (h.ok) {
      log('stack already up');
      printStatus(existing, h);
      return;
    }
    log(`stack unhealthy (${h.failing.join(', ')}); starting fresh`);
  }
  await down({ log });
  ensureDir(LOG_DIR);
  ensureDir(PERSIST_DIR);
  await preflight();

  const state = { version: 1, startedAt: new Date().toISOString(), ready: false, pids: {} };
  const save = () => writeState(state);

  log('starting the drand network');
  await run(
    'compose',
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'up', '--detach', '--quiet-pull'],
    {
      env: { ...process.env, STACK_DRAND_PORT: String(PORTS.drand) },
    },
  );
  const forkUrl = process.env.STACK_FORK_URL || null;
  state.pids.anvil = start('anvil', 'anvil', [
    '--host',
    '127.0.0.1',
    '--port',
    String(PORTS.anvil),
    '--chain-id',
    String(LOCAL_CHAIN_ID),
    ...(forkUrl ? ['--fork-url', forkUrl] : []),
  ]);
  state.pids.farcaster = start(
    'farcaster',
    process.execPath,
    [join(ROOT, 'e2e', 'mocks', 'farcaster', 'server.mjs')],
    { env: { ...process.env, MOCK_FARCASTER_PORT: String(PORTS.farcaster) } },
  );
  save();

  const migrations = run(
    'migrations',
    WRANGLER,
    ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', PERSIST_DIR],
    { cwd: API_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } },
  );

  log('running the drand DKG');
  await run('dkg', 'bash', [join(STACK_DIR, 'drand', 'dkg.sh')], {
    env: {
      ...process.env,
      DRAND_PERIOD: String(DRAND.period),
      DRAND_GENESIS_DELAY: String(DRAND.genesisDelay),
    },
  });
  // Through the control port: drand's HTTP API, asked before the DKG completes, keeps answering
  // with errors or stale data for a while afterwards.
  const info = await waitFor(
    'drand chain info',
    async () =>
      JSON.parse(
        await capture('docker', [
          'compose',
          '-f',
          COMPOSE_FILE,
          'exec',
          '-T',
          '-u',
          'drand',
          'drand0',
          'drand',
          'show',
          'chain-info',
          '--id',
          'default',
        ]),
      ),
    { timeoutMs: 60_000, intervalMs: 500 },
  );
  if (info.schemeID !== DRAND.scheme || info.period !== DRAND.period) {
    throw new Error(`drand chain is ${info.schemeID} / ${info.period}s, expected ${DRAND.scheme}`);
  }
  const chain = {
    chainHash: info.hash,
    publicKey: info.public_key,
    genesis: info.genesis_time,
    period: info.period,
  };
  state.drand = {
    url: urls.drand,
    ...chain,
    scheme: info.schemeID,
    nodes: DRAND.nodes,
    threshold: DRAND.threshold,
  };
  log(`drand chain ${chain.chainHash.slice(0, 12)}…, genesis ${chain.genesis}`);

  await waitForProcess(
    'anvil',
    state.pids.anvil,
    'anvil',
    async () => Number(await rpc(urls.anvil, 'eth_chainId')) === LOCAL_CHAIN_ID,
  );
  log('deploying the contracts (CREATE2)');
  const keys = freshKeys();
  const { deployer, deployment, raw } = await deploy(keys, chain);
  state.anvil = { rpcUrl: urls.anvil, chainId: LOCAL_CHAIN_ID, forkUrl: forkUrl ? 'set' : null };
  state.contracts = deployment;
  state.addresses = {
    deployer,
    ...Object.fromEntries(Object.entries(keys).map(([role, k]) => [role, k.address])),
  };
  save();

  writeDevVars({
    APP_ORIGIN: urls.appOrigin,
    EMAIL_FROM: 'codes@flocked.test',
    TOS_VERSION,
    DRAND_CHAIN_HASH: chain.chainHash,
    DRAND_PUBLIC_KEY: chain.publicKey,
    DRAND_GENESIS: chain.genesis,
    DRAND_PERIOD: chain.period,
    LOCAL_DEPLOYMENT: raw,
    RECEIPT_SIGNER_KEY: keys.receiptSigner.key,
    ANCHOR_KEY: keys.anchorer.key,
    OPERATOR_KEY: keys.operator.key,
    BASE_RPC_URL: urls.anvil,
    TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET,
    FARCASTER_AUTH_ORIGIN: urls.farcaster,
    FLOCKED_TEST_SEAM_KEY: randomBytes(32).toString('hex'),
  });
  if (!existsSync(join(WEB_DIST_DIR, 'index.html'))) {
    ensureDir(WEB_DIST_DIR);
    writeFileSync(
      join(WEB_DIST_DIR, 'index.html'),
      '<!doctype html><title>Flocked</title><p>Placeholder from pnpm stack:up; apps/web builds here.</p>\n',
    );
  }

  await migrations;
  log('starting wrangler dev');
  state.pids.wrangler = start(
    'wrangler',
    WRANGLER,
    [
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(PORTS.api),
      '--inspector-port',
      String(PORTS.inspector),
      '--persist-to',
      PERSIST_DIR,
      '--env-file',
      DEV_VARS_FILE,
      '--show-interactive-dev-session=false',
      '--log-level',
      'info',
    ],
    { cwd: API_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  state.apiUrl = urls.api;
  state.appOrigin = urls.appOrigin;
  state.farcasterUrl = urls.farcaster;
  state.devVars = rel(DEV_VARS_FILE);
  state.logs = rel(LOG_DIR);
  save();
  await waitForProcess(
    'wrangler',
    state.pids.wrangler,
    'wrangler dev',
    async () => (await fetch(`${urls.api}/api/v1/me`)).status === 401,
    { timeoutMs: 90_000, intervalMs: 500 },
  );
  await waitForProcess('farcaster', state.pids.farcaster, 'the Farcaster mock', () =>
    getJson(`${urls.farcaster}/health`),
  );

  log('waiting for beacons over HTTP');
  await waitFor(
    'drand beacons over HTTP',
    async () => {
      const served = await getJson(`${urls.drand}/info`);
      if (served.hash !== chain.chainHash) return false;
      const b = await getJson(`${urls.drand}/public/latest`);
      return b.round >= 1;
    },
    { timeoutMs: (DRAND.genesisDelay + 90) * 1000, intervalMs: 1000 },
  );

  state.ready = true;
  save();
  const h = await health(state);
  printStatus(state, h);
  if (!h.ok) throw new Error(`unhealthy after start: ${h.failing.join(', ')}`);
  log('stack up');
}

try {
  await main();
} catch (err) {
  console.error(`\nstack:up failed: ${err.message}`);
  console.error(`Logs: ${rel(LOG_DIR)}. Clean up with \`pnpm stack:down\`.`);
  process.exitCode = 1;
}
