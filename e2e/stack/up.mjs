#!/usr/bin/env node
// `pnpm stack:up`: the local stack (plan 4.4 `local`; e2e/stack/README.md).
//
//   1. a 3-node drand network in Docker (bls-unchained-g1-rfc9380, 3 s period) and its DKG;
//   2. anvil on chain 31337 (STACK_FORK_URL forks Base or any chain, keeping chain ID 31337);
//   3. the CREATE2 deploy (contracts/script/Deploy.s.sol) with the local drand genesis and period
//      and fresh role keys;
//   4. e2e/stack/.dev.vars (the drand chain, the deployment, fresh keys, the test seam key), the
//      signer's env file, the D1 migrations and config seeds, and one `wrangler dev --local` running
//      apps/api and apps/signer (the ticket signer behind the API's `SIGNER` binding), plus the
//      service mocks;
//   5. the cron driver (cron.mjs), which runs the Worker's cron jobs, as wrangler dev fires none.
//
// Idempotent: a healthy stack is left alone; anything else is torn down and started fresh. Stack
// facts go to e2e/stack/.state.json, logs to e2e/stack/.run/logs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { createPublicClient, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CRON_HEARTBEAT_FILE } from './cron.mjs';
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
  SIGNER_DIR,
  SIGNER_RUN_DIR,
  SIGNER_VARS_FILE,
  STACK_DIR,
  TOS_VERSION,
  TURNSTILE_TEST_SECRET,
  WATCHER_DIR,
  WATCHER_PERSIST_DIR,
  WATCHER_RUN_DIR,
  WATCHER_VARS_FILE,
  ANTHROPIC_MOCK_KEY,
  NEYNAR_MOCK,
  WEB_DIST_DIR,
  alive,
  ensureDir,
  getJson,
  parseJsonc,
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
  coinbase: `http://127.0.0.1:${PORTS.coinbase}`,
  eas: `http://127.0.0.1:${PORTS.eas}`,
  turnstile: `http://127.0.0.1:${PORTS.turnstile}`,
  anthropic: `http://127.0.0.1:${PORTS.anthropic}`,
  push: `http://127.0.0.1:${PORTS.push}`,
  'farcaster-notify': `http://127.0.0.1:${PORTS.farcasterNotify}`,
  email: `http://127.0.0.1:${PORTS.email}`,
  bundler: `http://127.0.0.1:${PORTS.bundler}`,
  watcher: `http://127.0.0.1:${PORTS.watcher}`,
  pager: `http://127.0.0.1:${PORTS.pager}`,
};

/**
 * The service mocks: the Farcaster Quick Auth (W3-A), Coinbase OAuth and API, and EAS (W5-B),
 * Turnstile's siteverify (W7-D), Anthropic's Messages API for moderation (W8-A), and the notification
 * channels (W9-A): a web push service, Farcaster's notification endpoint, hub and cast API, and email.
 */
const MOCKS = [
  ['farcaster', 'MOCK_FARCASTER_PORT', PORTS.farcaster],
  ['coinbase', 'MOCK_COINBASE_PORT', PORTS.coinbase],
  ['eas', 'MOCK_EAS_PORT', PORTS.eas],
  ['turnstile', 'MOCK_TURNSTILE_PORT', PORTS.turnstile],
  ['anthropic', 'MOCK_ANTHROPIC_PORT', PORTS.anthropic],
  ['push', 'MOCK_PUSH_PORT', PORTS.push],
  ['farcaster-notify', 'MOCK_FARCASTER_NOTIFY_PORT', PORTS.farcasterNotify],
  ['email', 'MOCK_EMAIL_PORT', PORTS.email],
  ['bundler', 'MOCK_BUNDLER_PORT', PORTS.bundler],
  ['pager', 'MOCK_PAGER_PORT', PORTS.pager],
];

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

/**
 * The ticket signer's env file and config (W6-B; NFR-7). Both Workers run in one `wrangler dev`, so
 * the API's `SIGNER` binding resolves in process and the signer reads the D1 the API writes. That
 * `wrangler dev` hands `--env-file` to the first config (the API) only, and loads a further config's
 * secrets from the `.dev.vars` beside that config. So the signer runs from a copy of
 * apps/signer/wrangler.jsonc in .run/signer (with `main` pointing back at apps/signer/src), whose
 * `.dev.vars` is a link to ticket-signer.dev.vars: TICKET_SIGNER_KEY reaches the signer and never
 * the API, and apps/signer/.dev.vars (a developer's own) is neither read nor touched.
 */
function writeSigner(keys, deploymentJson) {
  writeDevVars(
    { TICKET_SIGNER_KEY: keys.ticketSigner.key, LOCAL_DEPLOYMENT: deploymentJson },
    SIGNER_VARS_FILE,
  );
  const config = parseJsonc(readFileSync(join(SIGNER_DIR, 'wrangler.jsonc'), 'utf8'));
  delete config.$schema;
  // `main` is the only path in the signer's config; anything else relative would break here.
  config.main = join(SIGNER_DIR, config.main);
  ensureDir(SIGNER_RUN_DIR);
  const configFile = join(SIGNER_RUN_DIR, 'wrangler.json');
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  symlinkSync(relative(SIGNER_RUN_DIR, SIGNER_VARS_FILE), join(SIGNER_RUN_DIR, '.dev.vars'));
  return { name: config.name, configFile };
}

/** A second, wholly separate wrangler process for the independent watcher and its own D1. */
function writeWatcher(deploymentJson, chain) {
  const config = parseJsonc(readFileSync(join(WATCHER_DIR, 'wrangler.jsonc'), 'utf8'));
  delete config.$schema;
  config.main = join(WATCHER_DIR, config.main);
  config.vars = {
    ...config.vars,
    ENVIRONMENT: 'local',
    CHAIN_ID: String(LOCAL_CHAIN_ID),
    API_BASE_URL: `${urls.api}/api/v1`,
    BASE_RPC_URL: urls.anvil,
    ATTESTATION_RPC_URL: urls.eas,
    ATTESTATION_NETWORK: 'base',
    COUNTRY_ALLOW: 'US',
  };
  config.d1_databases = config.d1_databases?.map((db) => ({
    ...db,
    migrations_dir: join(WATCHER_DIR, 'migrations'),
  }));
  ensureDir(WATCHER_RUN_DIR);
  const configFile = join(WATCHER_RUN_DIR, 'wrangler.json');
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  writeDevVars(
    {
      LOCAL_DEPLOYMENT: deploymentJson,
      DRAND_INFO_URL: `${urls.drand}/info`,
      DRAND_CHAIN_HASH: chain.chainHash,
      DRAND_PUBLIC_KEY: chain.publicKey,
      DRAND_GENESIS: chain.genesis,
      DRAND_PERIOD: chain.period,
      WATCHER_KEY: generatePrivateKey(),
      PAGER_WEBHOOK_URL: `${urls.pager}/page`,
    },
    WATCHER_VARS_FILE,
  );
  return { name: config.name, configFile };
}

/**
 * Local config the API and the signer read (the `config` table; seeds have no `updated_by`):
 * Stakes is on and allowed in the US, the location `wrangler dev` gives every request (its
 * placeholder `request.cf`, since the stack turns the cf.json fetch off), so a stack test can take a
 * ticket through the API and the signer (e2e/tests/stakes-ticket.test.ts).
 */
const CONFIG_SEEDS = {
  'mode.stakes.enabled': 'true',
  'geo.stakes.allow': '["US"]',
};

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
  for (const [name, portVar, port] of MOCKS) {
    state.pids[name] = start(
      name,
      process.execPath,
      [join(ROOT, 'e2e', 'mocks', name, 'server.mjs')],
      { env: { ...process.env, [portVar]: String(port) } },
    );
  }
  save();

  const migrations = run(
    'migrations',
    WRANGLER,
    ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', PERSIST_DIR],
    { cwd: API_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } },
  );
  const watcherMigrations = run(
    'watcher-migrations',
    WRANGLER,
    [
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--persist-to',
      WATCHER_PERSIST_DIR,
      '--config',
      join(WATCHER_DIR, 'wrangler.jsonc'),
    ],
    { cwd: WATCHER_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } },
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
  // The escrow's ticket signer key, for the signer Worker and stack tests (W6). Never in the API's
  // .dev.vars: apps/api must have no access to it (NFR-7).
  state.signer = writeSigner(keys, raw);
  state.signer.configFile = rel(state.signer.configFile);
  save();
  state.watcher = writeWatcher(raw, chain);
  state.watcher.configFile = rel(state.watcher.configFile);
  save();

  const seamKey = randomBytes(32).toString('hex');
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
    // No stack test calls Cloudflare: siteverify goes to the mock (W7-D).
    TURNSTILE_SITEVERIFY_URL: `${urls.turnstile}/turnstile/v0/siteverify`,
    // Question moderation goes to the Anthropic mock (W8-A), honoured only locally.
    ANTHROPIC_BASE_URL: urls.anthropic,
    ANTHROPIC_API_KEY: ANTHROPIC_MOCK_KEY,
    FARCASTER_AUTH_ORIGIN: urls.farcaster,
    FLOCKED_TEST_SEAM_KEY: seamKey,
    // Settlement fetches beacons from the local drand network (W5-A).
    DRAND_RELAYS: urls.drand,
    // Personhood (W5-B): the Coinbase and EAS mocks, and a fresh person-ID key.
    PERSON_ID_KEY: randomBytes(32).toString('hex'),
    // Stakes person tags (W6-B): a fresh key every run.
    PERSON_TAG_KEY: randomBytes(32).toString('hex'),
    COINBASE_CLIENT_ID: 'mock-client-id',
    COINBASE_CLIENT_SECRET: 'mock-client-secret',
    COINBASE_LOGIN_ORIGIN: urls.coinbase,
    COINBASE_API_ORIGIN: urls.coinbase,
    ATTESTATION_NETWORK: 'base',
    ATTESTATION_RPC_URL: urls.eas,
    // Sponsorship stays local: one service stands in for both the provider's ERC-7677 endpoint and
    // its ERC-4337 bundler. The values are origins with a JSON-RPC POST at `/`.
    PAYMASTER_URL: urls.bundler,
    BUNDLER_URL: urls.bundler,
    // Notifications (W9-A): every channel goes to its mock. Web push needs no override (the test
    // subscribes with a loopback endpoint on the push mock, accepted only locally); the VAPID pair is
    // added below. The hub also answers wallet offers (W7-B) with nothing to offer.
    EMAIL_MOCK_URL: urls.email,
    FARCASTER_HUB_URL: urls['farcaster-notify'],
    FARCASTER_CAST_API_URL: urls['farcaster-notify'],
    NEYNAR_API_KEY: NEYNAR_MOCK.apiKey,
    FARCASTER_CAST_SIGNER_UUID: NEYNAR_MOCK.signerUuid,
  });
  // A fresh VAPID pair every run, appended to .dev.vars (the script prints only the public key).
  const vapid = await capture(
    process.execPath,
    [join(ROOT, 'scripts', 'gen-vapid.mjs'), DEV_VARS_FILE],
    {
      env: { ...process.env, VAPID_SUBJECT: 'mailto:ops@flocked.test' },
    },
  );
  state.vapidPublicKey = /^VAPID_PUBLIC_KEY=([A-Za-z0-9_-]+)$/m.exec(vapid)?.[1] ?? null;
  if (!existsSync(join(WEB_DIST_DIR, 'index.html'))) {
    ensureDir(WEB_DIST_DIR);
    writeFileSync(
      join(WEB_DIST_DIR, 'index.html'),
      '<!doctype html><title>Flocked</title><p>Placeholder from pnpm stack:up; apps/web builds here.</p>\n',
    );
  }

  await migrations;
  await watcherMigrations;
  const seededAt = Date.now();
  await run(
    'config-seeds',
    WRANGLER,
    [
      'd1',
      'execute',
      'DB',
      '--local',
      '--persist-to',
      PERSIST_DIR,
      '--command',
      `INSERT INTO config (key, value_json, updated_at) VALUES ${Object.entries(CONFIG_SEEDS)
        .map(([key, value]) => `('${key}', '${value}', ${seededAt})`)
        .join(', ')}`,
    ],
    { cwd: API_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } },
  );
  log('starting wrangler dev (the API and the ticket signer)');
  state.pids.wrangler = start(
    'wrangler',
    WRANGLER,
    [
      'dev',
      // The API first: it takes the port and --env-file; the signer reads .run/signer/.dev.vars.
      '--config',
      join(API_DIR, 'wrangler.jsonc'),
      '--config',
      join(ROOT, state.signer.configFile),
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
    {
      cwd: API_DIR,
      // No cf.json fetch: every request gets wrangler's placeholder `request.cf` (US, TX), so
      // geo checks see the same location on every machine (CONFIG_SEEDS).
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' },
    },
  );
  state.apiUrl = urls.api;
  state.appOrigin = urls.appOrigin;
  state.farcasterUrl = urls.farcaster;
  state.coinbaseUrl = urls.coinbase;
  state.easUrl = urls.eas;
  state.turnstileUrl = urls.turnstile;
  state.anthropicUrl = urls.anthropic;
  state.pushUrl = urls.push;
  state.farcasterNotifyUrl = urls['farcaster-notify'];
  state.emailUrl = urls.email;
  state.bundlerUrl = urls.bundler;
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
  log('starting the independent watcher');
  state.pids.watcher = start(
    'watcher',
    WRANGLER,
    [
      'dev',
      '--config',
      join(ROOT, state.watcher.configFile),
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(PORTS.watcher),
      '--inspector-port',
      String(PORTS.watcherInspector),
      '--persist-to',
      WATCHER_PERSIST_DIR,
      '--env-file',
      WATCHER_VARS_FILE,
      '--show-interactive-dev-session=false',
      '--log-level',
      'info',
    ],
    {
      cwd: WATCHER_DIR,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' },
    },
  );
  state.watcherUrl = urls.watcher;
  state.pagerUrl = urls.pager;
  save();
  await waitForProcess(
    'watcher',
    state.pids.watcher,
    'watcher dev',
    async () => (await getJson(`${urls.watcher}/health`)).ok === true,
    { timeoutMs: 90_000, intervalMs: 500 },
  );
  for (const [name] of MOCKS) {
    await waitForProcess(name, state.pids[name], `the ${name} mock`, () =>
      getJson(`${urls[name]}/health`),
    );
  }

  // wrangler dev fires no cron triggers; the driver runs them through the seam (cron.mjs).
  log('starting the cron driver');
  state.pids.cron = start('cron', process.execPath, [join(STACK_DIR, 'cron.mjs')], {
    env: {
      ...process.env,
      STACK_CRON_API: urls.api,
      STACK_CRON_KEY: seamKey,
      STACK_CRON_WATCHER: urls.watcher,
    },
  });
  save();
  await waitForProcess('cron', state.pids.cron, 'the first cron pass', () =>
    existsSync(CRON_HEARTBEAT_FILE),
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
