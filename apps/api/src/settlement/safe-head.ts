// Stakes settlement waits until Base's safe head has passed the close block (spec "Round
// lifecycle": pending → revealing; wave-6 pinned interface). The close block and the safe head come
// from src/chain/safe-head.ts; ALERT_SAFE_HEAD_LAG is raised by the entry set's stream
// (src/settlement/stakes/entry-set.ts), which waits for the same thing. Free has no such wait.
import type { Mode } from '@flocked/shared';
import { CloseBlockReorgedError, closeBlockFor, safeHeadPast } from '../chain/safe-head.js';
import type { Env } from '../env.js';
import { providerClient, type EscrowDeps } from './stakes/escrow.js';

/** True for Free; for Stakes, once the safe head is past the round's close block. */
export async function safeHeadReady(
  env: Env,
  roundId: string,
  mode: Mode,
  deps: EscrowDeps = {},
): Promise<boolean> {
  if (mode === 'free') return true;
  const round = await env.DB.prepare('SELECT closes_at FROM rounds WHERE id = ?1')
    .bind(roundId)
    .first<{ closes_at: number }>();
  if (!round) throw new Error(`safeHeadReady: no round ${roundId}`);
  const client = providerClient(env, 'primary', deps);
  if (!client) return false;
  const close = await closeBlockFor(client, Math.floor(round.closes_at / 1000));
  if (!close) return false;
  try {
    return await safeHeadPast(client, close);
  } catch (err) {
    if (err instanceof CloseBlockReorgedError) return false;
    throw err;
  }
}
