// NFR-8 (W3-A part): IPs are kept only within rate-limit windows, so no sign-in flow writes an IP
// to D1 or KV; sign-in secrets (session tokens, nonces, email codes) are stored only as hashes.
import { env } from 'cloudflare:test';
import { AuthSessionResponseSchema } from '@flocked/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IDS, seedFixture } from '../helpers/index.js';
import { authEnv, call, nonce, quickAuthSigner, siweBody } from './fixtures.js';

const IP = '198.18.7.42';
const FROM_IP = { 'CF-Connecting-IP': IP };

async function allTables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Every D1 row and every KV key and value, as one string per table / entry. */
async function storedText(): Promise<string[]> {
  const out: string[] = [];
  for (const table of await allTables()) {
    const { results } = await env.DB.prepare(`SELECT * FROM "${table}"`).all();
    out.push(`${table}: ${JSON.stringify(results)}`);
  }
  let cursor: string | undefined;
  do {
    const page = await env.KV.list(cursor ? { cursor } : {});
    for (const k of page.keys) out.push(`kv ${k.name}: ${(await env.KV.get(k.name)) ?? ''}`);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

const secrets: string[] = [];

beforeAll(async () => {
  await seedFixture(env.DB);
  const signer = await quickAuthSigner();
  const t = authEnv({ farcasterKeys: signer.keys });

  // SIWE sign-up (cookie), Farcaster sign-up (Bearer), email start + verify, a profile write.
  const account = privateKeyToAccount(generatePrivateKey());
  const siwe = await call(
    t.env,
    'POST',
    '/auth/siwe/verify',
    await siweBody(t.env, account, { turnstileToken: 'tok' }),
    FROM_IP,
  );
  expect(siwe.status).toBe(200);
  const fc = AuthSessionResponseSchema.parse(
    await (
      await call(
        t.env,
        'POST',
        '/auth/farcaster',
        { token: await signer.mint(424242), turnstileToken: 'tok' },
        FROM_IP,
      )
    ).json(),
  );
  secrets.push(fc.token as string);
  secrets.push(await nonce(t.env, FROM_IP)); // issued, never used: still in KV

  await env.DB.prepare(
    "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES ('01K700000000000000000PRIV1', ?1, 'email', 'private@flocked.test', 1)",
  )
    .bind(FIXTURE_IDS.user)
    .run();
  await call(t.env, 'POST', '/auth/email/start', { email: 'private@flocked.test' }, FROM_IP);
  const code = t.email.codes[0] as string;
  secrets.push(code);
  await call(t.env, 'POST', '/auth/email/start', { email: 'private@flocked.test' }, FROM_IP); // a second, unused code
  secrets.push(t.email.codes[1] as string);
  const email = await call(
    t.env,
    'POST',
    '/auth/email/verify',
    { email: 'private@flocked.test', code: t.email.codes[1], transport: 'bearer' },
    FROM_IP,
  );
  expect(email.status).toBe(200);
  const emailToken = AuthSessionResponseSchema.parse(await email.json()).token as string;
  secrets.push(emailToken);
  await call(
    t.env,
    'PATCH',
    '/me',
    { displayName: 'Private Ewe' },
    {
      ...FROM_IP,
      Authorization: `Bearer ${emailToken}`,
    },
  );
});

describe('NFR-8: no IPs stored', () => {
  it('no D1 table has an IP column', async () => {
    for (const table of await allTables()) {
      const { results } = await env.DB.prepare(
        `SELECT name FROM pragma_table_info('${table}')`,
      ).all<{
        name: string;
      }>();
      const ipColumns = results
        .map((r) => r.name)
        .filter((n) => /(^|_)ip($|_)|ip_?addr|remote_?addr/i.test(n));
      expect(ipColumns, table).toEqual([]);
    }
  });

  it('no D1 row and no KV entry contains the client IP after every sign-in flow', async () => {
    const hits = (await storedText()).filter((s) => s.includes(IP));
    expect(hits).toEqual([]);
  });
});

describe('sign-in secrets are stored only as hashes', () => {
  it('no session token, nonce or email code appears in D1 or KV', async () => {
    expect(secrets.length).toBeGreaterThanOrEqual(5);
    const text = (await storedText()).join('\n');
    for (const secret of secrets) expect(text.includes(secret), secret.slice(0, 4)).toBe(false);
  });
});
