// Writes fixtures/quicknet-ciphertexts.json: one pick encrypted in Node to each recorded quicknet round,
// so the Workers-runtime test decrypts ciphertexts made in another runtime. Encryption is randomized, so
// this ran once and its output is committed; tests never regenerate it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fixture from '../fixtures/quicknet-beacons.json' with { type: 'json' };
import {
  QUICKNET,
  commitment,
  encodePlaintext,
  encryptPick,
  roundRefFromChainId,
  toBase64Url,
} from '../src/index.js';
import { bytesToHex } from '../src/encoding.js';

const picks = [];
for (const [k, { round }] of fixture.beacons.entries()) {
  const roundRef = roundRefFromChainId(BigInt(1000 + k));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const optionIndex = (k % 2) as 0 | 1;
  const ct = await encryptPick(QUICKNET, round, encodePlaintext({ roundRef, optionIndex, nonce }));
  picks.push({
    round,
    roundRef: bytesToHex(roundRef),
    optionIndex,
    nonce: bytesToHex(nonce),
    ciphertext: toBase64Url(ct),
    commitment: commitment(ct),
  });
}
const file = join(import.meta.dirname, '../fixtures/quicknet-ciphertexts.json');
writeFileSync(file, `${JSON.stringify({ madeWith: 'encryptPick (Node)', picks }, null, 2)}\n`);
console.log(`wrote fixtures/quicknet-ciphertexts.json (${picks.length} picks)`);
