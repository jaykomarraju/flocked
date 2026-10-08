// src/points: atomic points movements (spec "Data model" › Atomic points movements) in the Workers
// runtime against real D1 batches.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SCOPE,
  POINTS,
  applyMovement,
  combineMovements,
  creditMovement,
  debitMovement,
  findBalanceMismatches,
  grantMovement,
  scopeForRound,
  stakeMovement,
} from '../src/points/index.js';
import { FIXED_NOW, balanceOf, ledgerCount } from './helpers/index.js';

const db = env.DB;
let clock = FIXED_NOW;
const tick = () => (clock += 1);

/** A new user with `points` in `scope`, via the signup grant (so ledger and balance agree). */
async function newPlayer(
  points: number = POINTS.signupGrant,
  scope = GLOBAL_SCOPE,
): Promise<string> {
  const userId = newUlid(tick());
  if (points > 0) {
    const out = await applyMovement(
      db,
      grantMovement(db, {
        userId,
        scope,
        amount: points,
        reason: 'signup',
        refId: userId,
        now: tick(),
      }),
    );
    expect(out.status).toBe('applied');
  }
  return userId;
}

function entryInsert(userId: string, roundId: string, stake: number, seq: number) {
  return db
    .prepare(
      "INSERT INTO entries (id, round_id, mode, user_id, stake, commitment, receipt_seq, created_at) VALUES (?1, ?2, 'free', ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(newUlid(tick()), roundId, userId, stake, `0x${'cc'.repeat(32)}`, seq, tick());
}

async function entryCount(roundId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM entries WHERE round_id = ?1')
    .bind(roundId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('stake (Free entry debit)', () => {
  it('debits, inserts the entry and the ledger row in one batch', async () => {
    const u = await newPlayer(500);
    const roundId = newUlid(tick());
    const m = stakeMovement(db, {
      userId: u,
      scope: GLOBAL_SCOPE,
      amount: 25,
      roundId,
      now: tick(),
      entryInsert: entryInsert(u, roundId, 25, 0),
    });
    expect(m.statements).toHaveLength(4); // spec steps 1–4
    const out = await applyMovement(db, m);
    expect(out).toEqual({ status: 'applied', ledgerIds: m.ledgerIds });
    expect(await balanceOf(db, u)).toBe(475);
    expect(await entryCount(roundId)).toBe(1);
    const row = await db
      .prepare('SELECT delta, reason, ref_id FROM points_ledger WHERE id = ?1')
      .bind(m.ledgerIds[0])
      .first();
    expect(row).toEqual({ delta: -25, reason: 'stake', ref_id: roundId });
  });

  it('insufficient balance rolls back every statement, including the entry', async () => {
    const u = await newPlayer(40);
    const roundId = newUlid(tick());
    const before = { balance: await balanceOf(db, u), ledger: await ledgerCount(db, u) };
    const out = await applyMovement(
      db,
      stakeMovement(db, {
        userId: u,
        scope: GLOBAL_SCOPE,
        amount: 41,
        roundId,
        now: tick(),
        entryInsert: entryInsert(u, roundId, 41, 0),
      }),
    );
    expect(out).toEqual({ status: 'insufficient_balance' });
    expect(await balanceOf(db, u)).toBe(before.balance);
    expect(await ledgerCount(db, u)).toBe(before.ledger);
    expect(await entryCount(roundId)).toBe(0);
  });

  it('with no balance row: rejected, and the row created in step 1 is rolled back too', async () => {
    const u = newUlid(tick());
    const out = await applyMovement(
      db,
      stakeMovement(db, { userId: u, scope: 'room-x', amount: 10, roundId: 'r', now: tick() }),
    );
    expect(out).toEqual({ status: 'insufficient_balance' });
    expect(await balanceOf(db, u, 'room-x')).toBeNull();
  });

  it('exact balance is allowed (balance reaches 0)', async () => {
    const u = await newPlayer(10);
    const out = await applyMovement(
      db,
      stakeMovement(db, {
        userId: u,
        scope: GLOBAL_SCOPE,
        amount: 10,
        roundId: newUlid(tick()),
        now: tick(),
      }),
    );
    expect(out.status).toBe('applied');
    expect(await balanceOf(db, u)).toBe(0);
  });

  it('a second stake for the same round is a duplicate and changes nothing', async () => {
    const u = await newPlayer(500);
    const roundId = newUlid(tick());
    const stake = () =>
      stakeMovement(db, { userId: u, scope: GLOBAL_SCOPE, amount: 10, roundId, now: tick() });
    expect((await applyMovement(db, stake())).status).toBe('applied');
    expect(await applyMovement(db, stake())).toEqual({ status: 'duplicate' });
    expect(await balanceOf(db, u)).toBe(490);
  });

  it('a failing caller statement (entry already exists) rolls back the debit and is rethrown', async () => {
    const u = await newPlayer(500);
    const roundId = newUlid(tick());
    await entryInsert(u, roundId, 10, 0).run();
    await expect(
      applyMovement(
        db,
        stakeMovement(db, {
          userId: u,
          scope: GLOBAL_SCOPE,
          amount: 10,
          roundId,
          now: tick(),
          entryInsert: entryInsert(u, roundId, 10, 1),
        }),
      ),
    ).rejects.toThrow('UNIQUE constraint failed: entries.');
    expect(await balanceOf(db, u)).toBe(500);
    expect(await ledgerCount(db, u)).toBe(1);
  });

  it('room rounds stake room points, not global points', async () => {
    const roomId = newUlid(tick());
    const u = await newPlayer(500);
    await applyMovement(
      db,
      grantMovement(db, {
        userId: u,
        scope: roomId,
        amount: 500,
        reason: 'room_grant',
        refId: roomId,
        now: tick(),
      }),
    );
    const scope = scopeForRound({ kind: 'room', roomId });
    await applyMovement(
      db,
      stakeMovement(db, { userId: u, scope, amount: 100, roundId: 'rr', now: tick() }),
    );
    expect(await balanceOf(db, u, roomId)).toBe(400);
    expect(await balanceOf(db, u)).toBe(500);
  });
});

describe('credit (payouts, refunds, awards)', () => {
  it('upserts the balance and inserts the ledger row', async () => {
    const u = await newPlayer(100);
    const out = await applyMovement(
      db,
      creditMovement(db, {
        userId: u,
        scope: GLOBAL_SCOPE,
        amount: 37,
        reason: 'payout',
        refId: 'round-1',
        now: tick(),
      }),
    );
    expect(out.status).toBe('applied');
    expect(await balanceOf(db, u)).toBe(137);
  });

  it('creates the balance row when missing', async () => {
    const u = newUlid(tick());
    await applyMovement(
      db,
      creditMovement(db, {
        userId: u,
        scope: 'room-y',
        amount: 5,
        reason: 'refund',
        refId: 'r',
        now: tick(),
      }),
    );
    expect(await balanceOf(db, u, 'room-y')).toBe(5);
  });

  it('a settlement retry (same ref) fails instead of crediting twice', async () => {
    const u = await newPlayer(100);
    const payout = () =>
      creditMovement(db, {
        userId: u,
        scope: GLOBAL_SCOPE,
        amount: 50,
        reason: 'payout',
        refId: 'round-2',
        now: tick(),
      });
    expect((await applyMovement(db, payout())).status).toBe('applied');
    expect(await applyMovement(db, payout())).toEqual({ status: 'duplicate' });
    expect(await balanceOf(db, u)).toBe(150);
    // A different reason with the same ref is a different movement.
    const rebate = creditMovement(db, {
      userId: u,
      scope: GLOBAL_SCOPE,
      amount: 3,
      reason: 'rebate',
      refId: 'round-2',
      now: tick(),
    });
    expect((await applyMovement(db, rebate)).status).toBe('applied');
    expect(await balanceOf(db, u)).toBe(153);
  });
});

describe('grant (with ledger ref)', () => {
  it('signup grant is credited once per user', async () => {
    const u = newUlid(tick());
    const signup = () =>
      grantMovement(db, {
        userId: u,
        scope: GLOBAL_SCOPE,
        amount: POINTS.signupGrant,
        reason: 'signup',
        refId: u,
        now: tick(),
      });
    expect((await applyMovement(db, signup())).status).toBe('applied');
    expect((await applyMovement(db, signup())).status).toBe('duplicate');
    expect(await balanceOf(db, u)).toBe(500);
  });

  it('daily grant: +100 once per round while the balance is below 1,000', async () => {
    const u = await newPlayer(500);
    const daily = (roundId: string) =>
      grantMovement(db, {
        userId: u,
        scope: GLOBAL_SCOPE,
        amount: POINTS.roundGrant,
        reason: 'daily_grant',
        refId: roundId,
        now: tick(),
        onlyIfBalanceBelow: POINTS.roundGrantBelow,
      });
    expect((await applyMovement(db, daily('round-a'))).status).toBe('applied');
    expect(await balanceOf(db, u)).toBe(600);
    expect(await applyMovement(db, daily('round-a'))).toEqual({ status: 'duplicate' });
    expect(await balanceOf(db, u)).toBe(600);
  });

  it('daily grant is skipped (no ledger row, no balance change) at 1,000 or more', async () => {
    const u = await newPlayer(1000);
    const ledgerBefore = await ledgerCount(db, u);
    const out = await applyMovement(
      db,
      grantMovement(db, {
        userId: u,
        scope: GLOBAL_SCOPE,
        amount: 100,
        reason: 'daily_grant',
        refId: 'round-b',
        now: tick(),
        onlyIfBalanceBelow: 1000,
      }),
    );
    expect(out).toEqual({ status: 'skipped' });
    expect(await balanceOf(db, u)).toBe(1000);
    expect(await ledgerCount(db, u)).toBe(ledgerBefore);
  });

  it('room grant for a member without a balance row (balance 0 < 1,000)', async () => {
    const u = newUlid(tick());
    const out = await applyMovement(
      db,
      grantMovement(db, {
        userId: u,
        scope: 'room-z',
        amount: 100,
        reason: 'room_grant',
        refId: 'round-c',
        now: tick(),
        onlyIfBalanceBelow: 1000,
      }),
    );
    expect(out.status).toBe('applied');
    expect(await balanceOf(db, u, 'room-z')).toBe(100);
  });
});

describe('combined movements (merge)', () => {
  it('moves a balance between accounts atomically', async () => {
    const losing = await newPlayer(300);
    const kept = await newPlayer(200);
    const mergeId = newUlid(tick());
    const m = combineMovements(
      debitMovement(db, {
        userId: losing,
        scope: GLOBAL_SCOPE,
        amount: 300,
        reason: 'merge',
        refId: mergeId,
        now: tick(),
      }),
      creditMovement(db, {
        userId: kept,
        scope: GLOBAL_SCOPE,
        amount: 300,
        reason: 'merge',
        refId: mergeId,
        now: tick(),
      }),
    );
    const out = await applyMovement(db, m);
    expect(out).toEqual({ status: 'applied', ledgerIds: m.ledgerIds });
    expect(await balanceOf(db, losing)).toBe(0);
    expect(await balanceOf(db, kept)).toBe(500);
  });

  it('if the debit fails, the paired credit does not happen', async () => {
    const losing = await newPlayer(100);
    const kept = await newPlayer(200);
    const mergeId = newUlid(tick());
    const out = await applyMovement(
      db,
      combineMovements(
        creditMovement(db, {
          userId: kept,
          scope: GLOBAL_SCOPE,
          amount: 101,
          reason: 'merge',
          refId: mergeId,
          now: tick(),
        }),
        debitMovement(db, {
          userId: losing,
          scope: GLOBAL_SCOPE,
          amount: 101,
          reason: 'merge',
          refId: mergeId,
          now: tick(),
        }),
      ),
    );
    expect(out).toEqual({ status: 'insufficient_balance' });
    expect(await balanceOf(db, losing)).toBe(100);
    expect(await balanceOf(db, kept)).toBe(200);
  });
});

describe('input validation', () => {
  it.each([0, -5, 1.5, Number.NaN, 2 ** 53])('rejects amount %s', (amount) => {
    expect(() =>
      creditMovement(db, {
        userId: 'u',
        scope: GLOBAL_SCOPE,
        amount,
        reason: 'payout',
        refId: 'r',
        now: 1,
      }),
    ).toThrow(RangeError);
  });

  it('rejects empty identifiers', () => {
    expect(() =>
      debitMovement(db, {
        userId: '',
        scope: GLOBAL_SCOPE,
        amount: 1,
        reason: 'admin',
        refId: 'a',
        now: 1,
      }),
    ).toThrow(TypeError);
    expect(() => scopeForRound({ kind: 'room', roomId: null })).toThrow(TypeError);
    expect(scopeForRound({ kind: 'daily' })).toBe('global');
  });
});

describe('sum(ledger) == balance', () => {
  type Op =
    | { kind: 'stake'; user: number; scope: number; amount: number; ref: number }
    | { kind: 'payout'; user: number; scope: number; amount: number; ref: number }
    | { kind: 'grant'; user: number; scope: number; amount: number; ref: number }
    | { kind: 'admin_debit'; user: number; scope: number; amount: number; ref: number };

  const opArb: fc.Arbitrary<Op> = fc.record({
    kind: fc.constantFrom('stake', 'payout', 'grant', 'admin_debit'),
    user: fc.integer({ min: 0, max: 2 }),
    scope: fc.integer({ min: 0, max: 1 }),
    amount: fc.integer({ min: 1, max: 400 }),
    // Small ref space so duplicate refs (retries) happen often.
    ref: fc.integer({ min: 0, max: 5 }),
  });

  function build(op: Op, users: string[], scopes: string[]) {
    const userId = users[op.user] as string;
    const scope = scopes[op.scope] as string;
    const base = { userId, scope, amount: op.amount, now: tick() };
    switch (op.kind) {
      case 'stake':
        return stakeMovement(db, { ...base, roundId: `round-${op.ref}` });
      case 'payout':
        return creditMovement(db, { ...base, reason: 'payout', refId: `round-${op.ref}` });
      case 'grant':
        return grantMovement(db, {
          ...base,
          reason: 'daily_grant',
          refId: `round-${op.ref}`,
          onlyIfBalanceBelow: 1000,
        });
      case 'admin_debit':
        return debitMovement(db, { ...base, reason: 'admin', refId: `audit-${op.ref}` });
    }
  }

  it('holds after any sequence of movements (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (ops) => {
        const users = [await newPlayer(200), await newPlayer(0), await newPlayer(900)];
        const scopes = [GLOBAL_SCOPE, newUlid(tick())];
        for (const op of ops) {
          const out = await applyMovement(db, build(op, users, scopes));
          expect(['applied', 'skipped', 'insufficient_balance', 'duplicate']).toContain(out.status);
        }
        for (const u of users) expect(await findBalanceMismatches(db, { userId: u })).toEqual([]);
      }),
      { numRuns: 25 },
    );
  });

  it('holds under concurrent batches on the same balances', async () => {
    const users = [await newPlayer(300), await newPlayer(50)];
    const scopes = [GLOBAL_SCOPE];
    const ops = fc.sample(
      fc.array(
        opArb.map((o) => ({ ...o, user: o.user % 2, scope: 0 })),
        { minLength: 60, maxLength: 60 },
      ),
      {
        numRuns: 1,
        seed: 7,
      },
    )[0] as Op[];
    const outcomes = await Promise.all(
      ops.map((op) => applyMovement(db, build(op, users, scopes))),
    );
    expect(outcomes.some((o) => o.status === 'applied')).toBe(true);
    for (const u of users) {
      expect(await findBalanceMismatches(db, { userId: u })).toEqual([]);
      expect(await balanceOf(db, u)).toBeGreaterThanOrEqual(0);
    }
  });

  it('findBalanceMismatches reports a drifted balance', async () => {
    const u = await newPlayer(100);
    await db.prepare('UPDATE point_balances SET balance = 99 WHERE user_id = ?1').bind(u).run();
    expect(await findBalanceMismatches(db, { userId: u })).toEqual([
      { userId: u, scope: GLOBAL_SCOPE, balance: 99, ledgerSum: 100 },
    ]);
  });
});
