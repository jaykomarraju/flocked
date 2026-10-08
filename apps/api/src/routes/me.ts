// Route module `me`: the caller's account. Owner: W3-A (profile, ToS), W5-B (personhood), W7-B
// (identities, merges, deletion), W8-B (referrals). Endpoints without an owner yet answer 501
// `not_implemented`; every endpoint is registered in ENDPOINTS order.
import {
  AcceptTosRequestSchema,
  UpdateMeRequestSchema,
  type AcceptTosResponse,
} from '@flocked/shared';
import { Hono } from 'hono';
import { tosVersion } from '../auth/config.js';
import { buildMe, loadMeUser, parsePrefs, tosView } from '../auth/profile.js';
import { limitUser } from '../auth/rate-limit.js';
import { getUser, requireUser, type AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError, errorResponse } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { endpointsOf } from './stub.js';

/** Display names: NFC, trimmed, no control or format characters. */
function cleanDisplayName(raw: string): string {
  const name = raw.normalize('NFC').trim();
  if (name.length === 0 || /\p{Cc}|\p{Cf}/u.test(name)) {
    throw new HttpError('bad_request', 'Invalid display name');
  }
  return name;
}

export const me = new Hono<AppEnv>();

/** W3-A's endpoints; the module's first three ENDPOINTS rows. */
const OWN = new Set(['GET /me', 'PATCH /me', 'POST /me/tos']);

me.get('/me', requireUser, async (c) => c.json(await buildMe(c.env, getUser(c).id)));

me.patch(
  '/me',
  requireUser,
  limitUser('writes'),
  validate('json', UpdateMeRequestSchema),
  async (c) => {
    const userId = getUser(c).id;
    const body = c.req.valid('json');
    const db = c.env.DB;
    const statements: D1PreparedStatement[] = [];

    if (body.handle !== undefined) {
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
    return c.json(await buildMe(c.env, userId));
  },
);

me.post(
  '/me/tos',
  requireUser,
  limitUser('writes'),
  validate('json', AcceptTosRequestSchema),
  async (c) => {
    const userId = getUser(c).id;
    const { tosVersion: accepted } = c.req.valid('json');
    if (accepted !== tosVersion(c.env)) {
      throw new HttpError('conflict', 'These are not the current Terms; reload and try again');
    }
    const t = now(c.env);
    await c.env.DB.prepare(
      'UPDATE users SET tos_version = ?1, tos_accepted_at = ?2, age_attested_at = ?2 WHERE id = ?3',
    )
      .bind(accepted, t, userId)
      .run();
    const body: AcceptTosResponse = { tos: tosView(c.env, await loadMeUser(c.env.DB, userId)) };
    return c.json(body);
  },
);

// The rest of the module answers 501 until its owner lands, in table order.
for (const ep of endpointsOf('me')) {
  if (OWN.has(`${ep.method} ${ep.path}`)) continue;
  me.on(ep.method, ep.path, (c) =>
    errorResponse(c, 'not_implemented', `${ep.method} ${ep.path} is not implemented yet`),
  );
}
