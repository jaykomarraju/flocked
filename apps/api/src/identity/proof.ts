// Proof of control of a sign-in identity (spec "Identity and personhood" › Identities: SIWE for a
// wallet, Farcaster auth, an email code). Linking and merge confirmation both start here; Coinbase
// is proven only through the personhood flow (src/personhood/flow.ts).
import type { ConfirmMergeRequest } from '@flocked/shared';
import type { SignInProvider } from '../auth/accounts.js';
import { authDeps } from '../auth/deps.js';
import { checkEmailCode, normalizeEmail } from '../auth/email.js';
import { verifyQuickAuth } from '../auth/farcaster.js';
import { verifySiwe } from '../auth/siwe.js';
import type { Env } from '../env.js';

export interface ProvenIdentity {
  provider: SignInProvider;
  /** Lowercase address, FID, or normalized email: `identities.external_id`. */
  externalId: string;
}

/** Checks the proof and consumes its nonce, token check or code. Throws the sign-in errors. */
export async function proveIdentity(env: Env, proof: ConfirmMergeRequest): Promise<ProvenIdentity> {
  switch (proof.provider) {
    case 'wallet':
      return { provider: 'wallet', externalId: await verifySiwe(env, authDeps(env), proof) };
    case 'farcaster':
      return {
        provider: 'farcaster',
        externalId: await verifyQuickAuth(env, authDeps(env), proof.token),
      };
    case 'email': {
      const email = normalizeEmail(proof.email);
      await checkEmailCode(env, email, proof.code);
      return { provider: 'email', externalId: email };
    }
  }
}
