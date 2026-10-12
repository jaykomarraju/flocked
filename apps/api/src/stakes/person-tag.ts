// Per-round person tags (spec "Identity and personhood" › Entry tickets (Stakes)):
// personTag = HMAC-SHA256(PERSON_TAG_KEY, "flocked/personTag/v1" ‖ person_id ‖ roundId), with
// person_id as stored (0x + 64 hex) and roundId the round's ULID (26 characters), both fixed length,
// so the concatenation is unambiguous. A new tag every round means the tag adds no link across
// rounds. Tags never reach a log (NFR-8).
import type { Hex } from 'viem';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';

export const PERSON_TAG_DOMAIN = 'flocked/personTag/v1';

const encoder = new TextEncoder();

/**
 * `PERSON_TAG_KEY` as raw key bytes: 32 or more bytes of hex (`openssl rand -hex 32`), with or
 * without `0x`. A missing or malformed key is a deployment error: tickets answer 503.
 */
function personTagKey(env: Pick<Env, 'PERSON_TAG_KEY'>): Uint8Array {
  const raw = (env.PERSON_TAG_KEY ?? '').replace(/^0x/, '');
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(raw)) {
    log.error('stakes_config_missing', { var: 'PERSON_TAG_KEY' });
    throw new HttpError('unavailable', 'Stakes tickets are unavailable right now');
  }
  const bytes = new Uint8Array(raw.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** The person's tag for one round, as lowercase bytes32 hex. */
export async function personTag(
  env: Pick<Env, 'PERSON_TAG_KEY'>,
  personId: string,
  roundId: string,
): Promise<Hex> {
  const key = await crypto.subtle.importKey(
    'raw',
    personTagKey(env),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${PERSON_TAG_DOMAIN}${personId}${roundId}`),
    ),
  );
  return `0x${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
