// RoundDO: one per round (spec "Real-time and the reveal"). Stub; W3-B implements init, enterFree,
// getState and the alarm chain, W4-D requestVoid and onModeResult wiring, W6-A ingestStakesEntry,
// W7-A the WebSocket hub (fetch upgrade, hibernation).
import { DurableObject } from 'cloudflare:workers';
import type { Mode } from '@flocked/shared';
import type { Env } from '../env.js';
import { notImplemented, notImplementedResponse } from './stub.js';
import type {
  EnterFreeRequest,
  EnterFreeResponse,
  LockedRound,
  ModeResult,
  RoundDORpc,
  RoundState,
  RpcResult,
  StakesEntryEvent,
  StakesIngestResult,
  VoidRequestResult,
} from './types.js';

export class RoundDO extends DurableObject<Env> implements RoundDORpc {
  init(_locked: LockedRound): Promise<RoundState> {
    return notImplemented('RoundDO.init');
  }

  enterFree(_req: EnterFreeRequest): Promise<RpcResult<EnterFreeResponse>> {
    return notImplemented('RoundDO.enterFree');
  }

  getState(): Promise<RoundState> {
    return notImplemented('RoundDO.getState');
  }

  ingestStakesEntry(_evt: StakesEntryEvent): Promise<StakesIngestResult> {
    return notImplemented('RoundDO.ingestStakesEntry');
  }

  onModeResult(_mode: Mode, _result: ModeResult): Promise<void> {
    return notImplemented('RoundDO.onModeResult');
  }

  requestVoid(): Promise<VoidRequestResult> {
    return notImplemented('RoundDO.requestVoid');
  }

  override fetch(_request: Request): Response {
    return notImplementedResponse('RoundDO.fetch');
  }
}
