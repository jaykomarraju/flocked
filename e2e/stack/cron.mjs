// The local stack's cron driver (W4-D; README "Crons"). `wrangler dev` never fires the Worker's cron
// triggers, so `pnpm stack:up` runs this process in their place: it asks the API to run a cron
// expression's jobs through the test seam (`POST /__test/cron`, local only, behind the per-run key),
// exactly what `scheduled` runs in production. The minute cron (scheduler tick and indexer kick) runs
// every STACK_CRON_INTERVAL_MS (default 5 s, so stack tests take seconds, not minutes) and the hourly
// one every STACK_CRON_HOURLY_MS (default 10 min). Runs never overlap. Each pass writes a heartbeat
// to .run/cron.json, which `pnpm stack:status` checks.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN_DIR, sleep } from './env.mjs';

export const CRON_HEARTBEAT_FILE = join(RUN_DIR, 'cron.json');
const EVERY_MINUTE = '* * * * *';
const HOURLY = '0 * * * *';

const api = process.env.STACK_CRON_API;
const key = process.env.STACK_CRON_KEY;
const intervalMs = Number(process.env.STACK_CRON_INTERVAL_MS ?? 5_000);
const hourlyMs = Number(process.env.STACK_CRON_HOURLY_MS ?? 600_000);

async function run(cron) {
  const res = await fetch(`${api}/__test/cron`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ cron }),
    // A tick can wait on transaction receipts (src/chain/operator.ts waits up to 20 s).
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!api || !key) throw new Error('STACK_CRON_API and STACK_CRON_KEY are required');
  let lastHourly = 0;
  for (;;) {
    const started = Date.now();
    const due = [EVERY_MINUTE];
    if (started - lastHourly >= hourlyMs) {
      due.push(HOURLY);
      lastHourly = started;
    }
    const results = [];
    for (const cron of due) {
      try {
        const r = await run(cron);
        results.push({ cron, ok: true, jobs: r.jobs });
      } catch (err) {
        results.push({ cron, ok: false, error: err.message });
        console.log(`${new Date().toISOString()} cron ${cron} failed: ${err.message}`);
      }
    }
    writeFileSync(
      CRON_HEARTBEAT_FILE,
      `${JSON.stringify({ at: Date.now(), intervalMs, results }, null, 2)}\n`,
    );
    await sleep(Math.max(0, intervalMs - (Date.now() - started)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`cron driver stopped: ${err.message}`);
    process.exit(1);
  });
}
