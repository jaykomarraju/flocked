// The `decrypt-daily` / `decrypt-rooms` consumers (spec "Architecture": Decrypt workers). One
// message per chunk of about 500 ciphertexts; the message carries only the chunk's R2 key. The
// consumer classifies every entry with the verified beacon, writes the chunk's results to R2 and
// reports its partial tally to the SettlementDO. Re-running a chunk writes the same bytes, and the
// SettlementDO counts each chunk once, so a redelivered message never double-counts.
import type { DecryptMessage } from '@flocked/shared';
import { chainFromEnv } from '@flocked/tlock';
import { settlementName } from '../do/settlement-do.js';
import type { Env } from '../env.js';
import { decryptChunk, type BeaconFile } from '../settlement/decrypt.js';
import { beaconKey, decryptChunkIndex, decryptOutputKey } from '../settlement/keys.js';
import type { DecryptInput } from '../settlement/prepare.js';

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`decrypt: ${key} is missing`);
  return obj.json<T>();
}

export async function decryptHandler(body: DecryptMessage, env: Env): Promise<void> {
  const { roundId, mode, chunkKey } = body;
  const index = decryptChunkIndex(roundId, mode, chunkKey);
  if (index === null) throw new Error(`decrypt: ${chunkKey} is not a chunk of ${roundId}:${mode}`);
  const input = await readJson<DecryptInput>(env.BUCKET, chunkKey);
  if (input.roundId !== roundId || input.mode !== mode || input.index !== index) {
    throw new Error(`decrypt: ${chunkKey} holds another chunk`);
  }
  const beacon = await readJson<BeaconFile>(env.BUCKET, beaconKey(roundId, mode));
  const chain = chainFromEnv(env as unknown as Record<string, string | undefined>);
  const { output, result } = await decryptChunk(input, chain, beacon);
  const resultKey = decryptOutputKey(roundId, mode, index);
  await env.BUCKET.put(resultKey, JSON.stringify(output), {
    httpMetadata: { contentType: 'application/json' },
  });
  const stub = env.SETTLEMENT.get(env.SETTLEMENT.idFromName(settlementName(roundId, mode)));
  await stub.chunkDone(chunkKey, { ...result, resultKey });
}
