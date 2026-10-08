// AnchorDO: singleton holding the anchor key and its nonce; signs, broadcasts and replaces every
// FlockedAnchor transaction (spec "Architecture"). Stub; W4-A implements it.
import { DurableObject } from 'cloudflare:workers';
import type { Hex } from 'viem';
import type { Env } from '../env.js';
import { notImplemented } from './stub.js';
import type {
  AnchorCommitItem,
  AnchorDORpc,
  AnchorKeyStatus,
  AnchorLockItem,
  AnchorManifestItem,
  AnchorSubmitAck,
} from './types.js';

/** The singleton's name: `env.ANCHOR.idFromName(ANCHOR_SINGLETON)`. */
export const ANCHOR_SINGLETON = 'anchor';

export class AnchorDO extends DurableObject<Env> implements AnchorDORpc {
  submitLock(_items: AnchorLockItem[]): Promise<AnchorSubmitAck> {
    return notImplemented('AnchorDO.submitLock');
  }

  submitCommit(_item: AnchorCommitItem): Promise<AnchorSubmitAck> {
    return notImplemented('AnchorDO.submitCommit');
  }

  submitManifest(_item: AnchorManifestItem): Promise<AnchorSubmitAck> {
    return notImplemented('AnchorDO.submitManifest');
  }

  status(_roundKey: Hex): Promise<AnchorKeyStatus> {
    return notImplemented('AnchorDO.status');
  }
}
