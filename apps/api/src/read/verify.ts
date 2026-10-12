// GET /rounds/:id/verify (spec "API": the bundle manifest and chunk URLs) and the bundle objects it
// points at (docs/bundle-format.md). A mode's bundle is listed and served only once that mode's
// `revealed_at` is set (Reveal gating): settlement writes the bundle before the reveal is public
// (Stakes writes it before `propose`, and `revealed_at` is set when the indexer sees
// `OutcomeProposed`). Modes refunded before the reveal (Free rules 4, 7 and 8; Stakes 1 and 4) have
// no bundle. Room rounds' bundles are members-only, like the rest of the round (the route's gate).
//
// The objects are served by the API under `/api/v1/rounds/:id/bundles/:mode/:file`, byte for byte,
// write-once and so immutable once public; a room round's are `private`.
import type { Mode, RoundVerifyResponse, VerifyBundle } from '@flocked/shared';
import { API_BASE_PATH } from '@flocked/shared';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { bundlePrefix, manifestKey } from '../settlement/keys.js';
import type { Manifest } from '../settlement/types.js';

interface VerifyRow {
  mode: Mode;
  lock_tx: string | null;
  commitment_root: string | null;
  commit_tx: string | null;
  bundle_hash: string;
  tx_hash: string | null;
}

/** The URL path of a bundle object (relative to the API origin). */
export function bundleObjectPath(roundId: string, mode: Mode, file: string): string {
  return `${API_BASE_PATH}/rounds/${roundId}/bundles/${mode}/${file}`;
}

/** GET /rounds/:id/verify's body; the caller has passed the round's access gate. */
export async function readVerify(env: Env, roundId: string): Promise<RoundVerifyResponse> {
  const { results } = await env.DB.prepare(
    `SELECT m.mode, m.lock_tx, m.commitment_root, m.commit_tx, s.bundle_hash, s.tx_hash
     FROM round_modes m JOIN settlements s ON s.round_id = m.round_id AND s.mode = m.mode
       AND s.superseded_at IS NULL
     WHERE m.round_id = ?1 AND m.revealed_at IS NOT NULL AND s.bundle_hash IS NOT NULL`,
  )
    .bind(roundId)
    .all<VerifyRow>();
  const out: RoundVerifyResponse = { roundId, modes: {} };
  for (const row of results) {
    const obj = await env.BUCKET.get(manifestKey(roundId, row.mode));
    if (!obj) {
      log.error('verify_manifest_missing', { roundId, mode: row.mode });
      continue;
    }
    const manifest = await obj.json<Pick<Manifest, 'chunks'>>();
    const free = row.mode === 'free';
    const bundle: VerifyBundle = {
      bundleHash: row.bundle_hash,
      manifestUrl: bundleObjectPath(roundId, row.mode, 'manifest.json'),
      chunkUrls: manifest.chunks.map((c) =>
        bundleObjectPath(roundId, row.mode, c.key.slice(bundlePrefix(roundId, row.mode).length)),
      ),
      lockTx: free ? row.lock_tx : null,
      commitmentRoot: free ? row.commitment_root : null,
      commitTx: free ? row.commit_tx : null,
      anchorTx: row.tx_hash,
    };
    out.modes[row.mode] = bundle;
  }
  return out;
}

/**
 * One bundle object, or null when the mode hasn't revealed or the object doesn't exist. The caller
 * has passed the round's access gate and checked `file` against `BundleFileSchema` (`@flocked/shared`).
 */
export async function readBundleObject(
  env: Env,
  roundId: string,
  mode: Mode,
  file: string,
): Promise<R2ObjectBody | null> {
  const revealed = await env.DB.prepare(
    'SELECT 1 AS ok FROM round_modes WHERE round_id = ?1 AND mode = ?2 AND revealed_at IS NOT NULL',
  )
    .bind(roundId, mode)
    .first<{ ok: number }>();
  if (!revealed) return null;
  return env.BUCKET.get(`${bundlePrefix(roundId, mode)}${file}`);
}
