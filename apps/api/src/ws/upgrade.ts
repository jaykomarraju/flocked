// GET /rounds/:id/ws (spec "Real-time and the reveal"): after the room-round gate (src/read/access.ts,
// in front of the route), the Worker gives the connection a random ID, picks its shard by
// hash(ID) mod N (src/ws/shards.ts) and forwards the upgrade to that RoundViewerDO, which accepts
// the socket and sends `state`. Only a GET with `Upgrade: websocket` is upgraded; anything else is
// 400 `bad_request`.
//
// Browsers send the session cookie (SameSite=Lax, so not on a cross-site handshake) with the
// upgrade; a Bearer token can't be set on a browser WebSocket, so a mini app reads room rounds over
// HTTP until a token transport is added (W7-A handoff, open issues).
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import type { RoundAccess } from '../read/access.js';
import {
  VIEWER_HEADER,
  shardOf,
  viewerShardCount,
  viewerStub,
  type ViewerConnect,
} from './shards.js';

export function isWebSocketUpgrade(request: Request): boolean {
  return request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

/** Forwards a checked upgrade to the connection's shard and returns its 101 (or error) answer. */
export function upgradeViewer(env: Env, request: Request, access: RoundAccess): Promise<Response> {
  if (!isWebSocketUpgrade(request)) {
    throw new HttpError('bad_request', 'Expected a WebSocket upgrade');
  }
  const connId = crypto.randomUUID();
  const shardCount = viewerShardCount(env);
  const shard = shardOf(connId, shardCount);
  const conn: ViewerConnect = {
    roundId: access.id,
    shard,
    shardCount,
    membersOnly: access.membersOnly,
    connId,
  };
  // Only what the shard needs: the client's cookies and tokens stay in the Worker.
  return viewerStub(env, access.id, shard).fetch(request.url, {
    headers: { Upgrade: 'websocket', [VIEWER_HEADER]: JSON.stringify(conn) },
  });
}
