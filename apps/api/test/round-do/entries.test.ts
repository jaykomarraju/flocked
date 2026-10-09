// RoundDO Free entries: the commit protocol (spec "Real-time and the reveal" › RoundDO
// responsibilities). Traceability DO-1, DO-2, DO-4; receipts are checked in receipt.test.ts and the
// close boundary in close-race.test.ts.
import { env, runInDurableObject } from 'cloudflare:test';
import { newUlid, ulidToBytes } from '@flocked/shared';
import { userIdHash } from '@flocked/settle';
import { commitment, fromBase64Url, toBase64Url } from '@flocked/tlock';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recoverReceiptSigner } from '../../src/crypto/receipt.js';
import { MAX_CIPHERTEXT_BYTES, entryInsert, isRoundSealedError } from '../../src/rounds/entry.js';
import { applyDailyGrant } from '../../src/rounds/grant.js';
import {
  BASE_OPENS_AT,
  HOUR,
  balance,
  createRound,
  createUser,
  entryCount,
  errCode,
  ledgerRows,
  okValue,
  sealedPick,
  seqs,
  setClock,
  useTestSigner,
  type TestRound,
} from './helpers.js';

const OPEN_NOW = BASE_OPENS_AT + 12 * HOUR;
let signer: `0x${string}`;

beforeAll(() => {
  signer = useTestSigner();
});
beforeEach(() => setClock(OPEN_NOW));

async function openRound(opts: Parameters<typeof createRound>[0] = {}): Promise<TestRound> {
  const r = await createRound(opts);
  await r.stub.init(r.locked);
  return r;
}

async function enter(r: TestRound, userId: string, stake = '25', ciphertext?: string) {
  return r.stub.enterFree({
    roundId: r.locked.roundId,
    userId,
    body: { stake, ciphertext: ciphertext ?? (await sealedPick(r.locked)) },
  });
}

describe('accepting a Free entry', () => {
  it('commits the stake batch, records the entry and returns a signed receipt', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const u = await createUser(500, scope);
    const ct = await sealedPick(r.locked, 1);
    const res = okValue(await enter(r, u, '25', ct));

    const c = commitment(fromBase64Url(ct) as Uint8Array);
    expect(res.entry).toMatchObject({
      roundId: r.locked.roundId,
      mode: 'free',
      stake: '25',
      commitment: c,
      createdAt: OPEN_NOW,
    });
    expect(res.receipt).toMatchObject({
      roundId: r.locked.roundId,
      mode: 'free',
      userIdHash: userIdHash(ulidToBytes(r.locked.roundId), ulidToBytes(u)),
      stake: '25',
      commitment: c,
      seq: 0,
      closesAt: r.locked.closesAt / 1000,
      beaconRound: r.locked.beaconRound,
      signer,
      chainId: 31337,
    });
    expect(await recoverReceiptSigner(res.receipt)).toBe(signer);

    expect(await balance(u, scope)).toBe(475);
    expect(await ledgerRows(u)).toEqual([
      { reason: 'admin', delta: 500 },
      { reason: 'stake', delta: -25 },
    ]);
    const row = await env.DB.prepare(
      'SELECT id, user_id, stake, commitment, receipt_seq, ciphertext FROM entries WHERE round_id = ?1',
    )
      .bind(r.locked.roundId)
      .first<{ id: string; stake: number; receipt_seq: number; ciphertext: ArrayBuffer }>();
    expect(row).toMatchObject({ id: res.entry.id, stake: 25, receipt_seq: 0 });
    expect(toBase64Url(new Uint8Array(row?.ciphertext ?? new ArrayBuffer(0)))).toBe(ct);

    const state = await r.stub.getState();
    expect(state).toMatchObject({ status: 'open', roundId: r.locked.roundId });
    expect(state.modes.free).toEqual({ status: 'pending', entrantCount: 1, pool: '25' });
  });

  it('gives each entry the next seq, 0, 1, 2, …', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    for (let i = 0; i < 4; i++) {
      const res = okValue(await enter(r, await createUser(100, scope), '10'));
      expect(res.receipt.seq).toBe(i);
    }
    expect(await seqs(r.locked.roundId)).toEqual([0, 1, 2, 3]);
  });
});

describe('DO-1: entry after close rejected; duplicate entry rejected', () => {
  it('rejects an entry at or after closesAt, and before opensAt', async () => {
    const r = await openRound();
    const u = await createUser(500, r.locked.roomId as string);
    const ct = await sealedPick(r.locked);
    setClock(r.locked.closesAt);
    expect(errCode(await enter(r, u, '25', ct))).toBe('round_closed');
    setClock(r.locked.closesAt + 60_000);
    expect(errCode(await enter(r, u, '25', ct))).toBe('round_closed');

    setClock(BASE_OPENS_AT - HOUR);
    const early = await createRound();
    await early.stub.init(early.locked);
    expect(errCode(await enter(early, u, '25', ct))).toBe('round_not_open');
    expect(await entryCount(r.locked.roundId)).toBe(0);
    expect(await entryCount(early.locked.roundId)).toBe(0);
  });

  it('rejects a second, different entry from the same user and keeps the first', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const u = await createUser(500, scope);
    okValue(await enter(r, u, '25'));
    expect(errCode(await enter(r, u, '25'))).toBe('already_entered');
    expect(errCode(await enter(r, u, '50'))).toBe('already_entered');
    expect(await balance(u, scope)).toBe(475);
    expect(await entryCount(r.locked.roundId)).toBe(1);
  });

  it('answers a retried identical request with the same receipt, without a second debit', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const u = await createUser(500, scope);
    const ct = await sealedPick(r.locked);
    const first = okValue(await enter(r, u, '25', ct));
    const again = okValue(await enter(r, u, '25', ct));
    expect(again).toEqual(first);
    expect(await balance(u, scope)).toBe(475);
  });

  it('serializes concurrent requests from one user: one entry, one debit', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const u = await createUser(500, scope);
    const ct = await sealedPick(r.locked);
    const results = await Promise.all([enter(r, u, '25', ct), enter(r, u, '25', ct)]);
    expect(results.map((x) => x.ok)).toEqual([true, true]);
    expect(okValue(results[0] as never)).toEqual(okValue(results[1] as never));
    expect(await balance(u, scope)).toBe(475);
    expect(await entryCount(r.locked.roundId)).toBe(1);
  });

  it('a retried stake that already committed (reply lost) gets its receipt, not insufficient_balance', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const u = await createUser(50, scope);
    const ct = await sealedPick(r.locked);
    const first = okValue(await enter(r, u, '50', ct));
    // Simulate a DO that committed to D1 but lost the reply and its leaf.
    await runInDurableObject(r.stub, (_i, state) => {
      state.storage.sql.exec('DELETE FROM leaves');
    });
    // The retry's debit now fails the balance CHECK before the entry's unique key.
    const retry = okValue(await enter(r, u, '50', ct));
    expect(retry).toEqual(first);
    expect(await balance(u, scope)).toBe(0);
    expect(await entryCount(r.locked.roundId)).toBe(1);
    // A different entry is still a duplicate.
    expect(errCode(await enter(r, u, '50'))).toBe('already_entered');
  });

  it('refuses an entry in an unknown or uninitialized round', async () => {
    const stub = env.ROUND.get(env.ROUND.idFromName(newUlid()));
    const res = await stub.enterFree({
      roundId: newUlid(),
      userId: newUlid(),
      body: { stake: '10', ciphertext: 'AA' },
    });
    expect(errCode(res)).toBe('not_found');
    const err = await stub.getState().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^not_found/);
  });
});

describe('DO-2: missing or insufficient balance rejected atomically; non-member room entry rejected', () => {
  it('insufficient balance leaves no entry, no ledger row and no seq gap', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const a = await createUser(100, scope);
    const poor = await createUser(20, scope);
    const b = await createUser(100, scope);
    expect(okValue(await enter(r, a, '25')).receipt.seq).toBe(0);
    expect(errCode(await enter(r, poor, '25'))).toBe('insufficient_balance');
    expect(await balance(poor, scope)).toBe(20);
    expect(await ledgerRows(poor)).toEqual([{ reason: 'admin', delta: 20 }]);
    expect(okValue(await enter(r, b, '25')).receipt.seq).toBe(1);
    expect(await seqs(r.locked.roundId)).toEqual([0, 1]);
    expect((await r.stub.getState()).modes.free).toMatchObject({ entrantCount: 2, pool: '50' });
  });

  it('a member with no balance row in the room is rejected the same way', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const u = await createUser(null, scope);
    expect(errCode(await enter(r, u, '10'))).toBe('insufficient_balance');
    expect(await entryCount(r.locked.roundId)).toBe(0);
    expect(await ledgerRows(u)).toEqual([]);
  });

  it('rejects a room entry from a non-member, even with points in that scope', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const outsider = await createUser(500, scope, { member: false });
    expect(errCode(await enter(r, outsider, '25'))).toBe('not_member');
    expect(await balance(outsider, scope)).toBe(500);
    expect(await entryCount(r.locked.roundId)).toBe(0);
  });
});

describe('DO-4: out-of-range stake, suspended and self-excluded entries rejected', () => {
  it.each(['9', '101', '0', '1000000'])('stake %s is outside 10–100', async (stake) => {
    const r = await openRound();
    const u = await createUser(10_000_000, r.locked.roomId as string);
    expect(errCode(await enter(r, u, stake))).toBe('stake_out_of_range');
  });

  it('accepts the bounds of the locked range, which need not be a preset', async () => {
    const r = await openRound({ free: { stakeMin: '5', stakeMax: '60', presets: ['5', '60'] } });
    const scope = r.locked.roomId as string;
    expect(okValue(await enter(r, await createUser(100, scope), '5')).entry.stake).toBe('5');
    expect(okValue(await enter(r, await createUser(100, scope), '60')).entry.stake).toBe('60');
    expect(okValue(await enter(r, await createUser(100, scope), '37')).entry.stake).toBe('37');
    expect(errCode(await enter(r, await createUser(100, scope), '61'))).toBe('stake_out_of_range');
  });

  it('rejects suspended and deleted accounts', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const suspended = await createUser(500, scope, { status: 'suspended' });
    const deleted = await createUser(500, scope, { status: 'deleted' });
    expect(errCode(await enter(r, suspended, '25'))).toBe('account_suspended');
    expect(errCode(await enter(r, deleted, '25'))).toBe('account_deleted');
    expect(await entryCount(r.locked.roundId)).toBe(0);
  });

  it('rejects a self-excluded user under the single exclusion rule', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const limits = async (u: string, cols: string, values: unknown[]) =>
      env.DB.prepare(
        `INSERT INTO limits (user_id, ${cols}) VALUES (?1, ${values.map((_, i) => `?${i + 2}`).join(', ')})`,
      )
        .bind(u, ...values)
        .run();
    const timed = await createUser(500, scope);
    await limits(timed, 'self_exclusion_until', [OPEN_NOW + 1]);
    const ended = await createUser(500, scope);
    await limits(ended, 'self_exclusion_until', [OPEN_NOW]);
    const permanent = await createUser(500, scope);
    await limits(permanent, 'self_exclusion_permanent', [1]);
    const liftPending = await createUser(500, scope);
    await limits(liftPending, 'self_exclusion_permanent, exclusion_lift_effective_at', [
      1,
      OPEN_NOW + 1,
    ]);
    const lifted = await createUser(500, scope);
    await limits(lifted, 'self_exclusion_permanent, exclusion_lift_effective_at', [1, OPEN_NOW]);

    expect(errCode(await enter(r, timed, '25'))).toBe('self_excluded');
    expect(errCode(await enter(r, permanent, '25'))).toBe('self_excluded');
    expect(errCode(await enter(r, liftPending, '25'))).toBe('self_excluded');
    okValue(await enter(r, ended, '25'));
    okValue(await enter(r, lifted, '25'));
    expect(await seqs(r.locked.roundId)).toEqual([0, 1]);
  });
});

describe('sealed pick checks at submit', () => {
  it('rejects a non-canonical header (armor, CRLF, extra stanza)', async () => {
    const r = await openRound();
    const u = await createUser(500, r.locked.roomId as string);
    const ct = fromBase64Url(await sealedPick(r.locked)) as Uint8Array;
    const text = String.fromCharCode(...ct);
    const header = text.slice(0, text.indexOf('\n--- '));
    const bytes = (str: string) => Uint8Array.from(str, (ch) => ch.charCodeAt(0));
    const crlf = bytes(header.replaceAll('\n', '\r\n') + text.slice(header.length));
    const armored = bytes(
      `-----BEGIN AGE ENCRYPTED FILE-----\n${btoa(text)}\n-----END AGE ENCRYPTED FILE-----\n`,
    );
    for (const bad of [crlf, armored, new Uint8Array([1, 2, 3])]) {
      expect(errCode(await enter(r, u, '25', toBase64Url(bad)))).toBe('invalid_ciphertext');
    }
    expect(await entryCount(r.locked.roundId)).toBe(0);
  });

  it('rejects a canonical header that targets another beacon round', async () => {
    const r = await openRound();
    const u = await createUser(500, r.locked.roomId as string);
    for (const round of [r.locked.beaconRound + 1, r.locked.beaconRound - 1]) {
      const ct = await sealedPick(r.locked, 0, round);
      expect(errCode(await enter(r, u, '25', ct))).toBe('invalid_ciphertext');
    }
  });

  it(`caps the ciphertext at ${MAX_CIPHERTEXT_BYTES} bytes`, async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const ct = fromBase64Url(await sealedPick(r.locked)) as Uint8Array;
    const padded = (n: number) =>
      toBase64Url(new Uint8Array([...ct, ...new Uint8Array(n - ct.length)]));
    expect(errCode(await enter(r, await createUser(500, scope), '25', padded(2049)))).toBe(
      'invalid_ciphertext',
    );
    // At the cap it is accepted at submit (it will be VOID decrypt_failed at settlement).
    okValue(await enter(r, await createUser(500, scope), '25', padded(MAX_CIPHERTEXT_BYTES)));
  });

  it('rejects entries in a round without a Free mode', async () => {
    const r = await openRound({ modes: ['stakes'] });
    const u = await createUser(500, r.locked.roomId as string);
    expect(errCode(await enter(r, u, '25'))).toBe('mode_unavailable');
  });
});

describe('daily grant on first entry (daily rounds)', () => {
  const daily = () => openRound({ kind: 'daily' });

  it('credits +100 below 1,000 before the stake, once', async () => {
    const r = await daily();
    const u = await createUser(500);
    okValue(await enter(r, u, '25'));
    expect(await balance(u)).toBe(575);
    expect(await ledgerRows(u)).toEqual([
      { reason: 'admin', delta: 500 },
      { reason: 'daily_grant', delta: 100 },
      { reason: 'stake', delta: -25 },
    ]);
    // Once: a later attempt the same day (here a refused second entry) credits nothing more.
    expect(errCode(await enter(r, u, '50'))).toBe('already_entered');
    expect(
      await applyDailyGrant(env.DB, { userId: u, roundId: r.locked.roundId, now: OPEN_NOW }),
    ).not.toEqual(expect.objectContaining({ status: 'applied' }));
    expect(await balance(u)).toBe(575);
  });

  it('a grant skipped at ≥ 1,000 is final for the game day, even after the balance drops', async () => {
    const r = await daily();
    const u = await createUser(1000);
    okValue(await enter(r, u, '100'));
    expect(await balance(u)).toBe(900);
    const skip = await env.DB.prepare(
      'SELECT balance FROM daily_grant_skips WHERE user_id = ?1 AND round_id = ?2',
    )
      .bind(u, r.locked.roundId)
      .first<{ balance: number }>();
    expect(skip).toEqual({ balance: 1000 });
    // A later visit or entry the same day finds the skip and does not grant.
    expect(
      await applyDailyGrant(env.DB, { userId: u, roundId: r.locked.roundId, now: OPEN_NOW }),
    ).toEqual({
      status: 'skipped',
    });
    expect(await balance(u)).toBe(900);
    expect((await ledgerRows(u)).map((x) => x.reason)).toEqual(['admin', 'stake']);
  });

  it('room rounds do not pay the daily grant', async () => {
    const r = await openRound();
    const scope = r.locked.roomId as string;
    const u = await createUser(500, scope);
    okValue(await enter(r, u, '25'));
    expect((await ledgerRows(u)).map((x) => x.reason)).toEqual(['admin', 'stake']);
  });
});

describe('the D1 seal', () => {
  it('an entry insert cannot commit once the round is closed in D1', async () => {
    const r = await openRound();
    await env.DB.prepare("UPDATE rounds SET status = 'closed' WHERE id = ?1")
      .bind(r.locked.roundId)
      .run();
    const insert = entryInsert(env.DB, {
      id: newUlid(),
      roundId: r.locked.roundId,
      userId: newUlid(),
      stake: 10,
      ciphertext: new Uint8Array([1]),
      commitment: `0x${'ab'.repeat(32)}`,
      now: OPEN_NOW,
    });
    const err = await insert.run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isRoundSealedError(err)).toBe(true);
    // And the DO refuses with round_closed rather than an internal error.
    const u = await createUser(500, r.locked.roomId as string);
    expect(errCode(await enter(r, u, '25'))).toBe('round_closed');
    expect(await balance(u, r.locked.roomId as string)).toBe(500);
  });
});
