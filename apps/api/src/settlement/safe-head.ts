// Stakes settlement waits until Base's safe head has passed the close block (spec "Round
// lifecycle": pending → revealing). That flag is a W6-A input; until W6-A builds it, Stakes waits
// here. Free has no such wait.
import type { Mode } from '@flocked/shared';
import type { Env } from '../env.js';

export async function safeHeadReady(_env: Env, _roundId: string, mode: Mode): Promise<boolean> {
  // W6-A: read the close block and the safe head (ALERT_SAFE_HEAD_LAG at beaconTime + 60 s).
  return Promise.resolve(mode === 'free');
}
