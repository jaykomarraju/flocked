// POST /rounds/:id/entries: requireUser, zod validation, the RoundDO's answer mapped to the error
// envelope (spec "API"; the RoundDO checks are in entries.test.ts).
import { env } from 'cloudflare:test';
import {
  API_BASE_PATH,
  CreateEntryResponseSchema,
  ERROR_STATUS,
  ErrorEnvelopeSchema,
  newUlid,
} from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { fakeUser, withSession } from '../helpers/index.js';
import {
  BASE_OPENS_AT,
  HOUR,
  createRound,
  createUser,
  sealedPick,
  setClock,
  useTestSigner,
  type TestRound,
} from './helpers.js';

let r: TestRound;
beforeAll(async () => {
  useTestSigner();
  setClock(BASE_OPENS_AT + HOUR);
  r = await createRound();
  await r.stub.init(r.locked);
});

function post(userId: string | null, roundId: string, body: unknown): Promise<Response> {
  const client = withSession(app, userId ? fakeUser({ id: userId }) : undefined);
  return Promise.resolve(
    client.request(
      `https://flocked.test${API_BASE_PATH}/rounds/${roundId}/entries`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    ),
  );
}

describe('POST /rounds/:id/entries', () => {
  it('201 with the entry and its receipt', async () => {
    const u = await createUser(500, r.locked.roomId as string);
    const res = await post(u, r.locked.roundId, {
      stake: '25',
      ciphertext: await sealedPick(r.locked),
    });
    expect(res.status).toBe(201);
    const body = CreateEntryResponseSchema.parse(await res.json());
    expect(body.receipt).toMatchObject({ roundId: r.locked.roundId, seq: 0, stake: '25' });
  });

  it('401 without a session', async () => {
    const res = await post(null, r.locked.roundId, { stake: '25', ciphertext: 'AA' });
    expect(res.status).toBe(401);
  });

  it.each([
    ['a non-decimal stake', { stake: '2.5', ciphertext: 'AA' }],
    ['a missing ciphertext', { stake: '25' }],
    ['an unknown field', { stake: '25', ciphertext: 'AA', optionIndex: 1 }],
  ])('400 for %s', async (_name, body) => {
    const res = await post(newUlid(), r.locked.roundId, body);
    expect(res.status).toBe(400);
    expect(ErrorEnvelopeSchema.parse(await res.json()).error.code).toBe('bad_request');
  });

  it('400 for a round ID that is not a ULID', async () => {
    const res = await post(newUlid(), 'not-a-round', { stake: '25', ciphertext: 'AA' });
    expect(res.status).toBe(400);
  });

  it('maps RoundDO rejections to their codes and statuses', async () => {
    const u = await createUser(500, r.locked.roomId as string);
    const cases: [string, unknown, string][] = [
      [
        r.locked.roundId,
        { stake: '5', ciphertext: await sealedPick(r.locked) },
        'stake_out_of_range',
      ],
      [r.locked.roundId, { stake: '25', ciphertext: 'AAAA' }, 'invalid_ciphertext'],
      [newUlid(), { stake: '25', ciphertext: 'AAAA' }, 'not_found'],
    ];
    for (const [roundId, body, code] of cases) {
      const res = await post(u, roundId, body);
      const envelope = ErrorEnvelopeSchema.parse(await res.json());
      expect(envelope.error.code).toBe(code);
      expect(res.status).toBe(ERROR_STATUS[code as keyof typeof ERROR_STATUS]);
    }
  });
});
