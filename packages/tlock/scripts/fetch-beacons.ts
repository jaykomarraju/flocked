// Fetches the recorded quicknet beacons into fixtures/quicknet-beacons.json. Run once by hand
// (`pnpm --filter @flocked/tlock exec tsx scripts/fetch-beacons.ts`); tests only read the file.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUICKNET } from '../src/chains.js';

const BASE = `https://api.drand.sh/${QUICKNET.chainHash}`;
// Round 1, the 1→2 and 9→10 digit steps of the stanza argument, two old rounds and two recent ones.
const ROUNDS = [1, 9, 10, 1_000_000, 12_345_678, 32_870_000, 32_870_075];

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

const infoUrl = `${BASE}/info`;
const info = await getJson(infoUrl);
if (info.hash !== QUICKNET.chainHash || info.public_key !== QUICKNET.publicKey) {
  throw new Error('drand info does not match the pinned QUICKNET constants');
}
const beacons = [];
for (const round of ROUNDS) {
  const source = `${BASE}/public/${round}`;
  const b = await getJson(source);
  if (b.round !== round) throw new Error(`${source}: got round ${String(b.round)}`);
  beacons.push({ round, randomness: b.randomness, signature: b.signature, source });
}
const out = { fetchedAt: new Date().toISOString(), info: { ...info, source: infoUrl }, beacons };
const file = join(import.meta.dirname, '../fixtures/quicknet-beacons.json');
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote fixtures/quicknet-beacons.json (${beacons.length} beacons)`);
