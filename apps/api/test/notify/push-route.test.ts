// POST /push/subscribe (src/routes/push.ts): upserts on the unique endpoint, stays open to suspended
// accounts (decision B7) and accepts only the browsers' push services.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { push, pushEndpointAllowed } from '../../src/routes/push.js';
import { fakeUser, seedFixture, withSession, type Fixture } from '../helpers/index.js';

let ids: Fixture['ids'];
beforeAll(async () => {
  ids = (await seedFixture(env.DB)).ids;
});

const body = (endpoint: string, p256dh = 'BKey12', auth = 'auth12') =>
  JSON.stringify({ endpoint, expirationTime: null, keys: { p256dh, auth } });

function subscribe(userId: string, payload: string, status: 'active' | 'suspended' = 'active') {
  return withSession(push, fakeUser({ id: userId, status })).request(
    '/push/subscribe',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload },
    env,
  );
}

describe('POST /push/subscribe', () => {
  it('stores a subscription, and a re-subscribe of the same endpoint moves it with new keys', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/one';
    const first = await subscribe(ids.user, body(endpoint));
    expect(first.status).toBe(200);
    const { id } = await first.json<{ id: string }>();
    const again = await subscribe(ids.otherUser, body(endpoint, 'BKey22', 'auth22'));
    expect(again.status).toBe(200);
    expect((await again.json<{ id: string }>()).id).toBe(id);
    const { results } = await env.DB.prepare(
      'SELECT id, user_id, keys_json FROM push_subscriptions WHERE endpoint = ?1',
    )
      .bind(endpoint)
      .all();
    expect(results).toEqual([
      {
        id,
        user_id: ids.otherUser,
        keys_json: JSON.stringify({ p256dh: 'BKey22', auth: 'auth22' }),
      },
    ]);
  });

  it('is open to a suspended account', async () => {
    const res = await subscribe(ids.user, body('https://web.push.apple.com/QK1'), 'suspended');
    expect(res.status).toBe(200);
  });

  it('refuses an endpoint that is not a push service, and a signed-out caller', async () => {
    const res = await subscribe(ids.user, body('https://attacker.example/collect'));
    expect(res.status).toBe(400);
    const anon = await withSession(push).request(
      '/push/subscribe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body('https://fcm.googleapis.com/x'),
      },
      env,
    );
    expect(anon.status).toBe(401);
  });
});

describe('pushEndpointAllowed', () => {
  it('accepts the push services over https, and loopback only locally', () => {
    const prod = { ENVIRONMENT: 'production' } as const;
    expect(pushEndpointAllowed('https://fcm.googleapis.com/fcm/send/x', prod)).toBe(true);
    expect(pushEndpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/x', prod)).toBe(
      true,
    );
    expect(pushEndpointAllowed('https://web.push.apple.com/x', prod)).toBe(true);
    expect(pushEndpointAllowed('https://wns2-par02p.notify.windows.com/w/?token=x', prod)).toBe(
      true,
    );
    expect(pushEndpointAllowed('http://fcm.googleapis.com/x', prod)).toBe(false);
    expect(pushEndpointAllowed('https://fcm.googleapis.com.evil.example/x', prod)).toBe(false);
    expect(pushEndpointAllowed('https://user:pw@fcm.googleapis.com/x', prod)).toBe(false);
    expect(pushEndpointAllowed('http://127.0.0.1:8794/push/a', prod)).toBe(false);
    expect(pushEndpointAllowed('http://127.0.0.1:8794/push/a', { ENVIRONMENT: 'local' })).toBe(
      true,
    );
  });
});
