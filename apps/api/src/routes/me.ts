// Route module `me`: the caller's account. Owner: W3-A (profile, ToS), W5-B (personhood), W7-B
// (identities, merges, email, deletion; the logic is in src/identity/), W8-B (referrals). Every
// endpoint is registered in ENDPOINTS order.
//
// Suspended accounts sign in read-only (spec "Identity and personhood" › Identities): every write
// here refuses `account_suspended`, except notification preferences, which are private and only
// quieten the account. The personhood routes are W5-B's and accept suspended accounts.
import {
  AcceptTosRequestSchema,
  AddEmailRequestSchema,
  ConfirmMergeRequestSchema,
  IdParamsSchema,
  LinkIdentityRequestSchema,
  PersonhoodCallbackQuerySchema,
  UpdateMeRequestSchema,
  VerifyEmailRequestSchema,
  isReservedHandle,
  type AcceptTosResponse,
  type AddEmailResponse,
  type ConfirmMergeResponse,
  type DeleteMeResponse,
  type MeResponse,
  type ReferralsResponse,
  type UnlinkIdentityResponse,
} from '@flocked/shared';
import { Hono, type Context } from 'hono';
import { tosVersion } from '../auth/config.js';
import { authDeps } from '../auth/deps.js';
import { emailHash, issueEmailCode, normalizeEmail } from '../auth/email.js';
import { buildMe, loadMeUser, parsePrefs, tosView } from '../auth/profile.js';
import { emailCodeBucket, enforce, limitAuthIp, limitUser } from '../auth/rate-limit.js';
import { clearSessionCookie } from '../auth/session.js';
import {
  identityView,
  loadCaller,
  refuseSuspended,
  type IdentityRow,
} from '../identity/accounts.js';
import { deleteAccount } from '../identity/delete.js';
import { linkIdentity, unlinkIdentity } from '../identity/link.js';
import { confirmMerge } from '../identity/merge.js';
import { refreshFarcasterOffers } from '../identity/offers.js';
import { proveIdentity } from '../identity/proof.js';
import { getUser, requireUser, type AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { validate } from '../lib/validate.js';
import { personhoodReturnUrl } from '../personhood/config.js';
import { stakesAgeRequirement, stakesEligibility } from '../personhood/eligibility.js';
import { completePersonhood, startPersonhood } from '../personhood/flow.js';

type Ctx = Context<AppEnv>;

/** Display names: NFC, trimmed, no control or format characters. */
function cleanDisplayName(raw: string): string {
  const name = raw.normalize('NFC').trim();
  if (name.length === 0 || /\p{Cc}|\p{Cf}/u.test(name)) {
    throw new HttpError('bad_request', 'Invalid display name');
  }
  return name;
}

/** Runs `task` after the response when the runtime allows; a failure only logs. */
function afterResponse(c: Ctx, what: string, task: () => Promise<unknown>): void {
  const run = task().then(
    () => undefined,
    (err: unknown) => {
      log.warn(`${what}_failed`, { error: err instanceof Error ? err.message : String(err) });
    },
  );
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    // No execution context (app.request in tests): the task still runs, unawaited.
  }
}

/** The caller's account row, refused while suspended. */
async function writableCaller(c: Ctx) {
  const caller = await loadCaller(c.env.DB, getUser(c).id);
  refuseSuspended(caller);
  return caller;
}

export const me = new Hono<AppEnv>();

/**
 * The /me view with Stakes eligibility from `stakesEligibility` (W5-B), which also checks the
 * attestations, `geo.stakes.allow`, the request location and the kill switch.
 */
async function meView(c: Ctx): Promise<MeResponse> {
  const user = getUser(c);
  const [ageRequired, stakes] = await Promise.all([
    stakesAgeRequirement(c.env, user.id, c.req.raw),
    stakesEligibility(c.env, user, c.req.raw),
  ]);
  return buildMe(c.env, user.id, ageRequired, stakes);
}

me.get('/me', requireUser, async (c) => {
  const userId = getUser(c).id;
  // Wallets verified on the user's Farcaster account, offered at most once a day.
  afterResponse(c, 'farcaster_offers', () => refreshFarcasterOffers(c.env, userId, now(c.env)));
  return c.json(await meView(c));
});

me.patch(
  '/me',
  requireUser,
  limitUser('writes'),
  validate('json', UpdateMeRequestSchema),
  async (c) => {
    const userId = getUser(c).id;
    const body = c.req.valid('json');
    const db = c.env.DB;
    if (body.handle !== undefined || body.displayName !== undefined || body.prefs !== undefined) {
      refuseSuspended(await loadCaller(db, userId));
    }
    const statements: D1PreparedStatement[] = [];

    if (body.handle !== undefined) {
      if (isReservedHandle(body.handle)) {
        throw new HttpError('handle_taken', 'That handle is reserved');
      }
      statements.push(
        db.prepare('UPDATE users SET handle = ?1 WHERE id = ?2').bind(body.handle, userId),
      );
    }
    if (body.displayName !== undefined) {
      const name = body.displayName === null ? null : cleanDisplayName(body.displayName);
      statements.push(
        db.prepare('UPDATE users SET display_name = ?1 WHERE id = ?2').bind(name, userId),
      );
    }
    if (body.prefs !== undefined) {
      const stored = parsePrefs((await loadMeUser(db, userId)).prefs_json);
      const { showCardAmounts, showStakesNet, creatorPayoutWallet } = body.prefs;
      if (showCardAmounts !== undefined) stored.show_card_amounts = showCardAmounts;
      if (showStakesNet !== undefined) stored.show_stakes_net = showStakesNet;
      if (creatorPayoutWallet !== undefined) {
        stored.creator_payout_wallet = creatorPayoutWallet?.toLowerCase() ?? null;
      }
      statements.push(
        db
          .prepare('UPDATE users SET prefs_json = ?1 WHERE id = ?2')
          .bind(JSON.stringify(stored), userId),
      );
    }
    for (const pref of body.notificationPrefs ?? []) {
      statements.push(
        db
          .prepare(
            'INSERT INTO notification_prefs (user_id, channel, event, enabled) VALUES (?1, ?2, ?3, ?4) ' +
              'ON CONFLICT (user_id, channel, event) DO UPDATE SET enabled = excluded.enabled',
          )
          .bind(userId, pref.channel, pref.event, pref.enabled ? 1 : 0),
      );
    }

    try {
      await db.batch(statements);
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed: users.handle')) {
        throw new HttpError('handle_taken', 'That handle is taken');
      }
      throw err;
    }
    return c.json(await meView(c));
  },
);

me.post(
  '/me/tos',
  requireUser,
  limitUser('writes'),
  validate('json', AcceptTosRequestSchema),
  async (c) => {
    const userId = (await writableCaller(c)).id;
    const { tosVersion: accepted, ageAttested } = c.req.valid('json');
    if (accepted !== tosVersion(c.env)) {
      throw new HttpError('conflict', 'These are not the current Terms; reload and try again');
    }
    // The checkbox names the age this request requires (personhood/age.ts); a lower attestation is
    // refused. `age_attested_min` records the age attested and is never lowered.
    const ageRequired = await stakesAgeRequirement(c.env, userId, c.req.raw);
    if (ageAttested < ageRequired) {
      throw new HttpError(
        'conflict',
        `Stakes here requires you to be ${ageRequired} or older; reload and try again`,
      );
    }
    const t = now(c.env);
    await c.env.DB.prepare(
      'UPDATE users SET tos_version = ?1, tos_accepted_at = ?2, age_attested_at = ?2, ' +
        'age_attested_min = CASE WHEN age_attested_at IS NOT NULL AND age_attested_min > ?4 ' +
        'THEN age_attested_min ELSE ?4 END WHERE id = ?3',
    )
      .bind(accepted, t, userId, ageAttested)
      .run();
    const body: AcceptTosResponse = {
      tos: tosView(c.env, await loadMeUser(c.env.DB, userId), ageRequired),
    };
    return c.json(body);
  },
);

me.post(
  '/me/identities/link',
  requireUser,
  limitUser('writes'),
  validate('json', LinkIdentityRequestSchema),
  async (c) => {
    const caller = await writableCaller(c);
    const proven = await proveIdentity(c.env, c.req.valid('json'));
    const t = now(c.env);
    const result = await linkIdentity(c.env, caller, proven, t);
    if (result.status === 'linked' && proven.provider === 'farcaster') {
      await refreshFarcasterOffers(c.env, caller.id, t, true);
    }
    return c.json(result);
  },
);

me.post(
  '/me/merges/:id/confirm',
  requireUser,
  limitUser('writes'),
  validate('param', IdParamsSchema),
  validate('json', ConfirmMergeRequestSchema),
  async (c) => {
    const caller = await writableCaller(c);
    const proven = await proveIdentity(c.env, c.req.valid('json'));
    const merge = await confirmMerge(c.env, caller.id, c.req.valid('param').id, proven, now(c.env));
    return c.json({ merge } satisfies ConfirmMergeResponse);
  },
);

me.delete(
  '/me/identities/:id',
  requireUser,
  limitUser('writes'),
  validate('param', IdParamsSchema),
  async (c) => {
    const caller = await writableCaller(c);
    await unlinkIdentity(c.env, caller.id, c.req.valid('param').id, now(c.env));
    const { results } = await c.env.DB.prepare(
      'SELECT id, user_id, provider, external_id, verified_at FROM identities WHERE user_id = ?1 ORDER BY id',
    )
      .bind(caller.id)
      .all<IdentityRow>();
    return c.json({ identities: results.map(identityView) } satisfies UnlinkIdentityResponse);
  },
);

me.post(
  '/me/email',
  requireUser,
  limitUser('writes'),
  validate('json', AddEmailRequestSchema),
  async (c) => {
    await writableCaller(c);
    const email = normalizeEmail(c.req.valid('json').email);
    await enforce(c, emailCodeBucket(await emailHash(email)));
    const { expiresAt } = await issueEmailCode(c.env, authDeps(c.env).email, email);
    return c.json({ email, codeExpiresAt: expiresAt } satisfies AddEmailResponse);
  },
);

me.post(
  '/me/email/verify',
  requireUser,
  limitUser('writes'),
  validate('json', VerifyEmailRequestSchema),
  async (c) => {
    const caller = await writableCaller(c);
    const { email, code } = c.req.valid('json');
    const proven = await proveIdentity(c.env, { provider: 'email', email, code });
    return c.json(await linkIdentity(c.env, caller, proven, now(c.env)));
  },
);

// Coinbase personhood (W5-B; src/personhood/). The callback is authenticated by its single-use
// OAuth state, never by the session; a session of another user than the state's is refused.
me.post('/me/personhood', requireUser, limitUser('writes'), async (c) =>
  c.json(await startPersonhood(c.env, getUser(c).id)),
);

me.get(
  '/me/personhood/callback',
  limitAuthIp,
  validate('query', PersonhoodCallbackQuerySchema),
  async (c) => {
    const userId = c.get('user')?.id ?? null;
    const { outcome } = await completePersonhood(c.env, c.req.valid('query'), userId);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    if ((c.req.header('accept') ?? '').includes('application/json')) return c.json(outcome);
    const target = new URL(personhoodReturnUrl(c.env));
    target.searchParams.set('personhood', outcome.status);
    if (outcome.status === 'failed') target.searchParams.set('reason', outcome.reason);
    return c.redirect(target.toString(), 302);
  },
);

// Referrals land in W8-B; until then the caller has none.
me.get('/me/referrals', requireUser, async (c) => {
  const { ref_code } = await loadMeUser(c.env.DB, getUser(c).id);
  return c.json({ refCode: ref_code, referrals: [], rewardTotal: '0' } satisfies ReferralsResponse);
});

me.delete('/me', requireUser, limitUser('writes'), async (c) => {
  await deleteAccount(c.env, getUser(c).id, now(c.env));
  clearSessionCookie(c);
  return c.json({ ok: true } satisfies DeleteMeResponse);
});
