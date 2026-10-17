// The reveal animation plays once per round and mode on this device (spec "Reveal choreography":
// "tracked locally"), also when the page loads after the reveal.
import { readLocal, writeLocal } from '../../lib/storage';

const key = (roundId: string, mode: 'free' | 'stakes') => `flocked.revealed.${roundId}.${mode}`;

export function revealPlayed(roundId: string, mode: 'free' | 'stakes'): boolean {
  return readLocal(key(roundId, mode)) === '1';
}

export function markRevealPlayed(roundId: string, mode: 'free' | 'stakes'): void {
  writeLocal(key(roundId, mode), '1');
}
