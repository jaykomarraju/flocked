// AuthDO: single-use SIWE nonces, email codes and OAuth state with attempt counters (spec "Data
// model", "Identity and personhood"). Stub; W3-A implements it (W5-B uses the OAuth state).
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { notImplemented } from './stub.js';
import type {
  AuthDORpc,
  ConsumeResult,
  EmailCodeAttempt,
  EmailCodeResult,
  OAuthStateBinding,
  OAuthStateResult,
} from './types.js';

export class AuthDO extends DurableObject<Env> implements AuthDORpc {
  consumeNonce(_nonceHash: string): Promise<ConsumeResult> {
    return notImplemented('AuthDO.consumeNonce');
  }

  consumeEmailCode(_attempt: EmailCodeAttempt): Promise<EmailCodeResult> {
    return notImplemented('AuthDO.consumeEmailCode');
  }

  bindOAuthState(_binding: OAuthStateBinding): Promise<void> {
    return notImplemented('AuthDO.bindOAuthState');
  }

  consumeOAuthState(_stateHash: string): Promise<OAuthStateResult> {
    return notImplemented('AuthDO.consumeOAuthState');
  }
}
