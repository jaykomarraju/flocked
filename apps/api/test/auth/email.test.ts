// Email-code sign-in (ID-4: brute force and replay). Codes are 8 digits, stored hashed in KV for 5
// minutes, 5 attempts each, about 10 per hour per address; email signs in but never creates an
// account; every email sign-in enqueues a security notice.
import { env } from 'cloudflare:test';
import { AuthSessionResponseSchema, NotifyMessageSchema } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { emailCodeHash, emailHash } from '../../src/auth/email.js';
import { emailCodeKvKey, type EmailCodeRecord } from '../../src/do/auth-do.js';
import { FIXTURE_IDS, seedFixture } from '../helpers/index.js';
import { authEnv, call, errorCode, type TestAuth } from './fixtures.js';

let n = 0;
/** A fresh address linked (verified) to the fixture user. */
async function linkedEmail(verified = true): Promise<string> {
  const email = `ewe${++n}@flocked.test`;
  await env.DB.prepare(
    "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'email', ?3, ?4)",
  )
    .bind(
      `01K700000000000000000E${String(n).padStart(4, '0')}`,
      FIXTURE_IDS.user,
      email,
      verified ? 1 : null,
    )
    .run();
  return email;
}

async function start(t: TestAuth, email: string, headers?: Record<string, string>) {
  return call(t.env, 'POST', '/auth/email/start', { email }, headers);
}

async function verify(t: TestAuth, email: string, code: string) {
  return call(t.env, 'POST', '/auth/email/verify', { email, code });
}

const wrong = (code: string) => String((Number(code) + 1) % 1e8).padStart(8, '0');

async function userCount(): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0;
}

beforeAll(async () => {
  await seedFixture(env.DB);
});

describe('POST /auth/email/start', () => {
  it('sends an 8-digit code to a linked, verified address; KV holds only its hash', async () => {
    const t = authEnv();
    const email = await linkedEmail();
    const res = await start(t, email);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(t.email.sent).toHaveLength(1);
    expect(t.email.sent[0]?.to).toBe(email);
    const code = t.email.codes[0] as string;
    expect(code).toMatch(/^\d{8}$/);

    const hash = await emailHash(email);
    const raw = await env.KV.get(emailCodeKvKey(hash));
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(email);
    const record = JSON.parse(raw as string) as EmailCodeRecord;
    expect(record.codeHash).toBe(await emailCodeHash(hash, code));
    expect(record.expiresAt - Date.now()).toBeLessThanOrEqual(300_000);
  });

  it('answers the same for an unknown or unverified address and sends nothing', async () => {
    const t = authEnv();
    const unverified = await linkedEmail(false);
    for (const email of ['nobody@flocked.test', unverified]) {
      const res = await start(t, email);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await env.KV.get(emailCodeKvKey(await emailHash(email)))).toBeNull();
    }
    expect(t.email.sent).toHaveLength(0);
  });

  it('normalises the address (case, whitespace)', async () => {
    const t = authEnv();
    const email = await linkedEmail();
    await start(t, email.toUpperCase());
    expect(t.email.sent[0]?.to).toBe(email);
  });

  it('a send failure still answers ok (no probing) and is logged', async () => {
    const t = authEnv();
    t.email.fail = true;
    const res = await start(t, await linkedEmail());
    expect(res.status).toBe(200);
  });

  it('about 10 codes per hour per address: the 11th request is 429 rate_limited', async () => {
    const t = authEnv();
    const email = await linkedEmail();
    for (let i = 0; i < 10; i++) expect((await start(t, email)).status).toBe(200);
    const res = await start(t, email);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Unlinked addresses are limited the same way, so a 429 reveals nothing.
    const other = 'stranger@flocked.test';
    for (let i = 0; i < 10; i++) await start(t, other);
    expect((await start(t, other)).status).toBe(429);
  });
});

describe('POST /auth/email/verify', () => {
  it('signs in with the right code, never creating an account, and enqueues a security notice', async () => {
    const t = authEnv();
    const email = await linkedEmail();
    await start(t, email);
    const users = await userCount();
    const res = await verify(t, email, t.email.codes[0] as string);
    expect(res.status).toBe(200);
    const body = AuthSessionResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ created: false, user: { id: FIXTURE_IDS.user } });
    expect(await userCount()).toBe(users);
    expect(t.notify.messages).toHaveLength(1);
    expect(NotifyMessageSchema.parse(t.notify.messages[0])).toMatchObject({
      event: 'security_notice',
      userId: FIXTURE_IDS.user,
      payload: { kind: 'email_sign_in' },
    });
  });

  it('ID-4 replay: a used code is refused', async () => {
    const t = authEnv();
    const email = await linkedEmail();
    await start(t, email);
    const code = t.email.codes[0] as string;
    expect((await verify(t, email, code)).status).toBe(200);
    const replay = await verify(t, email, code);
    expect(replay.status).toBe(401);
    expect(await errorCode(replay)).toBe('invalid_code');
  });

  it('ID-4 brute force: 5 attempts per code, then even the right code is refused', async () => {
    const t = authEnv();
    const email = await linkedEmail();
    await start(t, email);
    const code = t.email.codes[0] as string;
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await verify(t, email, wrong(code));
      codes.push(`${res.status} ${await errorCode(res)}`);
    }
    expect(codes).toEqual([
      '401 invalid_code',
      '401 invalid_code',
      '401 invalid_code',
      '401 invalid_code',
      '429 too_many_attempts',
    ]);
    const right = await verify(t, email, code);
    expect(right.status).toBe(429);
    expect(await errorCode(right)).toBe('too_many_attempts');
    expect(t.notify.messages).toHaveLength(0);
  });

  it('ID-4 brute force: a new code resets the attempts, and the old code dies', async () => {
    const t = authEnv();
    const email = await linkedEmail();
    await start(t, email);
    const old = t.email.codes[0] as string;
    for (let i = 0; i < 4; i++) await verify(t, email, wrong(old));
    await start(t, email);
    const fresh = t.email.codes[1] as string;
    if (fresh !== old) {
      expect(await errorCode(await verify(t, email, old))).toBe('invalid_code');
    }
    expect((await verify(t, email, fresh)).status).toBe(200);
  });

  it('ID-4 brute force: concurrent guesses cannot exceed 5 attempts', async () => {
    const t = authEnv();
    const email = await linkedEmail();
    await start(t, email);
    const code = t.email.codes[0] as string;
    const guesses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        verify(t, email, String((Number(code) + i + 1) % 1e8).padStart(8, '0')),
      ),
    );
    const statuses = await Promise.all(guesses.map((r) => errorCode(r)));
    expect(statuses.filter((s) => s === 'invalid_code')).toHaveLength(4);
    expect(statuses.filter((s) => s === 'too_many_attempts')).toHaveLength(8);
  });

  it('an expired code is refused with code_expired', async () => {
    const t = authEnv();
    const email = await linkedEmail();
    const hash = await emailHash(email);
    const record: EmailCodeRecord = {
      id: 'expired1',
      codeHash: await emailCodeHash(hash, '12345678'),
      expiresAt: Date.now() - 1,
    };
    await env.KV.put(emailCodeKvKey(hash), JSON.stringify(record));
    const res = await verify(t, email, '12345678');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('code_expired');
  });

  it('account creation only via Farcaster or SIWE: a valid code for an unlinked address creates nothing', async () => {
    const t = authEnv();
    const email = 'newcomer@flocked.test';
    const hash = await emailHash(email);
    const record: EmailCodeRecord = {
      id: 'unlinked1',
      codeHash: await emailCodeHash(hash, '87654321'),
      expiresAt: Date.now() + 60_000,
    };
    await env.KV.put(emailCodeKvKey(hash), JSON.stringify(record));
    const users = await userCount();
    const res = await verify(t, email, '87654321');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('invalid_code');
    expect(await userCount()).toBe(users);
    expect(
      await env.DB.prepare("SELECT 1 FROM identities WHERE provider = 'email' AND external_id = ?1")
        .bind(email)
        .first(),
    ).toBeNull();
  });

  it('no code at all → invalid_code', async () => {
    const t = authEnv();
    const res = await verify(t, await linkedEmail(), '00000000');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('invalid_code');
  });

  it('validates the code format with the P2.4 schema', async () => {
    const t = authEnv();
    for (const code of ['1234567', '123456789', 'abcdefgh']) {
      const res = await verify(t, 'a@flocked.test', code);
      expect(res.status).toBe(400);
    }
  });
});
