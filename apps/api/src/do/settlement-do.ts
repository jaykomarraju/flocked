// SettlementDO: one per (round, mode); tracks decrypt chunks and triggers the reduce step when all
// are done, idempotently (spec "Architecture"). Stub; W5-A implements it.
import { DurableObject } from 'cloudflare:workers';
import type { Mode } from '@flocked/shared';
import type { Env } from '../env.js';
import { notImplemented } from './stub.js';
import type {
  DecryptChunkResult,
  SettlementDORpc,
  SettlementKey,
  SettlementStatus,
} from './types.js';

/** The instance name for a (round, mode): `env.SETTLEMENT.idFromName(settlementName(...))`. */
export function settlementName(roundId: string, mode: Mode): string {
  return `${roundId}:${mode}`;
}

export class SettlementDO extends DurableObject<Env> implements SettlementDORpc {
  start(_key: SettlementKey): Promise<{ started: boolean; status: SettlementStatus }> {
    return notImplemented('SettlementDO.start');
  }

  chunkDone(_chunkKey: string, _result: DecryptChunkResult): Promise<SettlementStatus> {
    return notImplemented('SettlementDO.chunkDone');
  }

  status(): Promise<SettlementStatus> {
    return notImplemented('SettlementDO.status');
  }
}
