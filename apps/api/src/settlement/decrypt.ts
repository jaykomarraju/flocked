// One decrypt chunk (spec "Architecture": Decrypt workers): every ciphertext opened with the one
// verified signature through `classify`, in the chunk's seq order. About 6.4 ms of CPU per entry in
// workerd (W2-A; the spec's estimate is 10–18 ms), so a 500-entry chunk needs 3–9 s of the
// Worker's 60 s `cpu_ms`. Pure apart from `classify`'s once-per-isolate self-test.
import type { OptionIndex, VoidReason } from '@flocked/settle';
import type { Mode } from '@flocked/shared';
import { classify, fromBase64Url, type DrandChain } from '@flocked/tlock';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import type { DecryptChunkResult, ModeTally } from '../do/types.js';
import type { DecryptInput } from './prepare.js';

/** The verified beacon the coordinator writes before fanning out (R2 working file). */
export interface BeaconFile {
  round: number;
  signature: string;
}

export interface OutputEntry {
  seq: number;
  entryId: string;
  option: OptionIndex | null;
  nonce: Hex | null;
  voidReason: VoidReason | null;
}

/** A chunk's per-entry results (R2 working file at `DecryptChunkResult.resultKey`). */
export interface DecryptOutput {
  roundId: string;
  mode: Mode;
  index: number;
  entries: OutputEntry[];
}

/**
 * Classifies every entry of `input`. Throws (so the message is retried) when the signature fails
 * verification or the runtime is broken; a bad ciphertext is a VOID, never a throw.
 */
export async function decryptChunk(
  input: DecryptInput,
  chain: DrandChain,
  beacon: BeaconFile,
): Promise<{ output: DecryptOutput; result: Omit<DecryptChunkResult, 'resultKey'> }> {
  if (beacon.round !== input.beaconRound) {
    throw new Error(`beacon round ${beacon.round} is not the chunk's ${input.beaconRound}`);
  }
  const roundRef = hexToBytes(input.roundRef);
  const n = [0, 0];
  const w = [0n, 0n];
  const voids: Partial<Record<VoidReason, number>> = {};
  const entries: OutputEntry[] = [];
  for (const e of input.entries) {
    let out: OutputEntry;
    if (e.preVoid !== null) {
      out = { seq: e.seq, entryId: e.entryId, option: null, nonce: null, voidReason: e.preVoid };
    } else {
      const ct = e.ciphertext === null ? null : fromBase64Url(e.ciphertext);
      if (!ct) throw new Error(`entry ${e.entryId}: the chunk's ciphertext is not base64url`);
      const c = await classify({
        ct,
        chain,
        beaconRound: input.beaconRound,
        signature: beacon.signature,
        roundRef,
      });
      out = c.valid
        ? {
            seq: e.seq,
            entryId: e.entryId,
            option: c.optionIndex,
            nonce: bytesToHex(c.nonce),
            voidReason: null,
          }
        : { seq: e.seq, entryId: e.entryId, option: null, nonce: null, voidReason: c.voidReason };
    }
    if (out.option === null) {
      const reason = out.voidReason ?? 'decrypt_failed';
      voids[reason] = (voids[reason] ?? 0) + 1;
    } else {
      n[out.option] = (n[out.option] ?? 0) + 1;
      w[out.option] = (w[out.option] ?? 0n) + BigInt(e.stake);
    }
    entries.push(out);
  }
  const tally: ModeTally = [
    { headcount: n[0] ?? 0, total: (w[0] ?? 0n).toString() },
    { headcount: n[1] ?? 0, total: (w[1] ?? 0n).toString() },
  ];
  return {
    output: { roundId: input.roundId, mode: input.mode, index: input.index, entries },
    result: { entries: entries.length, valid: (n[0] ?? 0) + (n[1] ?? 0), tally, voids },
  };
}
