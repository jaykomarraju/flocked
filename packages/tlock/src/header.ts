// Strict parser for the age v1 header of a tlock ciphertext (spec: "Canonical ciphertext header").
// tlock-js's own reader is lenient, so every ciphertext passes through here before it touches tlock-js.
import type { DrandChain } from './chains.js';
import { base64Decode } from './encoding.js';

const VERSION_LINE = 'age-encryption.org/v1';
const LF = 0x0a;
/** A canonical quicknet header is about 330 bytes; anything this long without a MAC line is malformed. */
const MAX_HEADER = 4096;
const ROUND_RE = /^(0|[1-9][0-9]*)$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const ARG_RE = /^[\x21-\x7e]+$/;

export interface ParsedHeader {
  /** The stanza's round argument, canonical decimal. */
  round: string;
  /** The stanza's chain-hash argument, 64 lowercase hex chars. */
  chainHash: string;
  /** The decoded stanza body (U ‖ V ‖ W). */
  body: Uint8Array;
}

/**
 * Parses the header if it is canonical in structure and encoding: the age v1 version line, exactly one
 * stanza of type `tlock` with exactly two arguments (a canonical decimal and a lowercase hex hash),
 * a body of 64-column strict base64 lines ending in a shorter line, and a `--- ` MAC line of 32 bytes.
 * Returns null otherwise. It does not compare the arguments with any target.
 */
export function parseHeader(ct: Uint8Array): ParsedHeader | null {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < ct.length && i < MAX_HEADER; i++) {
    const c = ct[i] ?? 0;
    if (c === LF) {
      const line = String.fromCharCode(...ct.subarray(start, i));
      lines.push(line);
      start = i + 1;
      if (line.startsWith('---')) break;
    } else if (c < 0x20 || c > 0x7e) {
      return null; // header lines are printable ASCII; no CR, no tabs
    }
  }
  const mac = lines.at(-1);
  if (lines.length < 4 || mac === undefined || !mac.startsWith('--- ')) return null;
  if (lines[0] !== VERSION_LINE) return null;

  const arg = (lines[1] ?? '').split(' ');
  if (arg.length !== 4 || arg[0] !== '->' || arg[1] !== 'tlock') return null;
  const [, , round = '', chainHash = ''] = arg;
  if (!ARG_RE.test(round) || !ARG_RE.test(chainHash)) return null;
  if (!ROUND_RE.test(round) || !HASH_RE.test(chainHash)) return null;

  // Body: zero or more 64-column lines, then exactly one shorter final line, then the MAC line.
  const bodyLines = lines.slice(2, -1);
  const last = bodyLines.at(-1);
  if (last === undefined || last.length >= 64) return null;
  if (bodyLines.slice(0, -1).some((l) => l.length !== 64)) return null;
  const body = base64Decode(bodyLines.join(''));
  if (!body) return null;

  const macBytes = base64Decode(mac.slice(4));
  if (!macBytes || macBytes.length !== 32) return null;
  return { round, chainHash, body };
}

/** True when the header is canonical and targets exactly `beaconRound` on `chain`. */
export function isCanonicalHeader(ct: Uint8Array, chain: DrandChain, beaconRound: number): boolean {
  const h = parseHeader(ct);
  return h !== null && h.round === String(beaconRound) && h.chainHash === chain.chainHash;
}
