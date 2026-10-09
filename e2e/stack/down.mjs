#!/usr/bin/env node
// `pnpm stack:down`: stops everything `pnpm stack:up` started and deletes its state. Idempotent:
// with nothing running it only makes sure the drand containers and the state files are gone.
// Processes are stopped by the PIDs recorded in .state.json only, never by port.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  COMPOSE_FILE,
  DEPLOYMENT_FILE,
  DEV_VARS_FILE,
  RUN_DIR,
  STATE_FILE,
  alive,
  readState,
  removePath,
  sleep,
} from './env.mjs';

/** SIGTERM to the process group (wrangler's workerd child included), then SIGKILL after 5 s. */
async function stopGroup(name, pid, log) {
  if (!alive(pid)) return;
  log(`stopping ${name} (pid ${pid})`);
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  };
  signal('SIGTERM');
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  if (alive(pid)) signal('SIGKILL');
}

export async function down({ log = console.log } = {}) {
  const state = readState();
  if (state) {
    for (const [name, pid] of Object.entries(state.pids ?? {})) await stopGroup(name, pid, log);
  }
  const compose = spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'down', '--volumes', '--remove-orphans', '--timeout', '2'],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );
  if (compose.error) log(`docker compose down skipped: ${compose.error.message}`);
  else if (compose.status !== 0) throw new Error(`docker compose down failed:\n${compose.stderr}`);
  for (const p of [STATE_FILE, DEV_VARS_FILE, DEPLOYMENT_FILE, RUN_DIR]) removePath(p);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await down();
  console.log('stack down');
}
