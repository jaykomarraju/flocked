// IndexerDO: polls Base every few seconds via alarms from closesAt − 5 min until proposals confirm,
// mirroring FlockedEscrow and FlockedAnchor events into D1 (spec "Architecture" Chain indexer).
// Stub; W4-B implements it.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { notImplemented } from './stub.js';
import type { IndexerDORpc, IndexerPollResult, IndexerStatus } from './types.js';

/** The singleton's name: `env.INDEXER.idFromName(INDEXER_SINGLETON)`. */
export const INDEXER_SINGLETON = 'indexer';

export class IndexerDO extends DurableObject<Env> implements IndexerDORpc {
  poll(): Promise<IndexerPollResult> {
    return notImplemented('IndexerDO.poll');
  }

  status(): Promise<IndexerStatus> {
    return notImplemented('IndexerDO.status');
  }
}
