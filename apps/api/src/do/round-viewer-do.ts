// RoundViewerDO: WebSocket fan-out shard for large reveals (spec "Architecture"; N = 16 shards per
// round, "Non-functional requirements" › Scaling notes). Stub; W7-A implements it.
import { DurableObject } from 'cloudflare:workers';
import type { WsServerMessage, WsStateMessage } from '@flocked/shared';
import type { Env } from '../env.js';
import { notImplemented, notImplementedResponse } from './stub.js';
import type { RoundViewerDORpc, ViewerSubscription } from './types.js';

export class RoundViewerDO extends DurableObject<Env> implements RoundViewerDORpc {
  subscribe(_sub: ViewerSubscription): Promise<WsStateMessage> {
    return notImplemented('RoundViewerDO.subscribe');
  }

  broadcast(_message: WsServerMessage): Promise<{ delivered: number }> {
    return notImplemented('RoundViewerDO.broadcast');
  }

  override fetch(_request: Request): Response {
    return notImplementedResponse('RoundViewerDO.fetch');
  }
}
