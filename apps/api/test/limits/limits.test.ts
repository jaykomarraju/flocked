// PUT /me/limits and POST /me/limits/exclusion-lift (spec "Compliance and responsible play" ›
// Responsible play), with the test clock. E2E-9 (API): a timed exclusion can't be shortened; a
// permanent one lifts only 7 days after a request made 6 months in. Also: a cap decrease is
// immediate and an increase waits 24 hours; every change writes an audit row; suspended accounts
// may still protect themselves but not loosen anything.
import { env } from 'cloudflare:test';
import {
  ExclusionLiftResponseSchema,
  MAX_DAILY_STAKE_CAP_KEY,
  MeResponseSchema,
  SetLimitsResponseSchema,
  newUlid,
  type LimitsState,
  type MeLimits,
} from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { parseMaxDailyCap } from '../../src/limits/max-cap.js';
import { addMonths, excludedSql } from '../../src/limits/rules.js';
import { limitsView } from '../../src/auth/profile.js';
import { realSession, seedFixture, withFixedClock } from '../helpers/index.js';
import { authEnv, call, errorCode } from '../auth/fixtures.js';
import { newUser } from '../personhood/fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const USDC = 1_000_000;
const T0 = Date.UTC(2026, 0, 31, 12, 0, 0);

let n = 0;

/** A fresh account and a clock the test moves; `at(ms)` returns the env for that time. */
async function subject() {
  const id = newUlid(T0 - 30 * DAY + ++n);
  await newUser(id, T0 - 30 * DAY);
  const base = authEnv().env;
  const { headers } = await realSession(base, id);
  const at = (ms: number): Env => withFixedClock(base, ms);
  const put = async (ms: number, body: unknown) => call(at(ms), 'PUT', '/me/limits', body, headers);
  const lift = async (ms: number) =>
    call(at(ms), 'POST', '/me/limits/exclusion-lift', undefined, headers);
  const limits = async (ms: number): Promise<MeLimits> =>
    MeResponseSchema.parse(await (await call(at(ms), 'GET', '/me', undefined, headers)).json())
      .limits;
  return { id, put, lift, limits };
}

async function ok(res: Response): Promise<LimitsState> {
  expect(res.status, await res.clone().text()).toBe(200);
  return SetLimitsResponseSchema.parse(await res.json()).limits;
}

async function code(res: Response): Promise<[number, string]> {
  return [res.status, await errorCode(res)];
}

describe('E2E-9 (API): self-exclusion', () => {
  it("a timed exclusion can't be shortened or ended, only lengthened or made permanent", async () => {
    const s = await subject();
    const thirty = await ok(await s.put(T0, { selfExclusion: '30d' }));
    expect(thirty).toMatchObject({
      excluded: true,
      selfExclusion: { startedAt: T0, until: T0 + 30 * DAY, permanent: false },
    });
    // A day later: 7 days would end it sooner.
    expect(await code(await s.put(T0 + DAY, { selfExclusion: '7d' }))).toEqual([
      409,
      'exclusion_cannot_shorten',
    ]);
    // 30 days from day 1 ends later than 30 from day 0: that lengthens it.
    const longer = await ok(await s.put(T0 + DAY, { selfExclusion: '30d' }));
    expect(longer.selfExclusion).toMatchObject({ startedAt: T0, until: T0 + 31 * DAY });
    const sixMonths = await ok(await s.put(T0 + 2 * DAY, { selfExclusion: '6m' }));
    expect(sixMonths.selfExclusion.until).toBe(addMonths(T0 + 2 * DAY, 6));
    // Still excluded the day before it ends, not after.
    const end = sixMonths.selfExclusion.until ?? 0;
    expect((await s.limits(end - 1)).excluded).toBe(true);
    expect((await s.limits(end)).excluded).toBe(false);
    // Nothing to lift: only a permanent exclusion is lifted.
    expect(await code(await s.lift(T0 + 3 * DAY))).toEqual([409, 'exclusion_not_permanent']);
  });

  it('a permanent exclusion lifts only on request 6 months in, and only 7 days later', async () => {
    const s = await subject();
    const perm = await ok(await s.put(T0, { selfExclusion: 'permanent' }));
    expect(perm).toMatchObject({
      excluded: true,
      selfExclusion: { startedAt: T0, until: null, permanent: true, liftRequestedAt: null },
    });
    // No shortening to a timed exclusion.
    expect(await code(await s.put(T0 + DAY, { selfExclusion: '6m' }))).toEqual([
      409,
      'exclusion_cannot_shorten',
    ]);
    // Too early: 6 calendar months from Jan 31 is Jul 31.
    const sixMonths = addMonths(T0, 6);
    expect(new Date(sixMonths).toISOString()).toBe('2026-07-31T12:00:00.000Z');
    expect(await code(await s.lift(addMonths(T0, 5)))).toEqual([409, 'exclusion_lift_too_early']);
    expect(await code(await s.lift(sixMonths - 1))).toEqual([409, 'exclusion_lift_too_early']);
    // Six months in: accepted, effective 7 days later.
    const res = await s.lift(sixMonths);
    expect(res.status).toBe(200);
    const lifted = ExclusionLiftResponseSchema.parse(await res.json()).limits;
    expect(lifted).toMatchObject({
      excluded: true,
      selfExclusion: { liftRequestedAt: sixMonths, liftEffectiveAt: sixMonths + 7 * DAY },
    });
    // A second request doesn't move the date.
    const again = ExclusionLiftResponseSchema.parse(await (await s.lift(sixMonths + DAY)).json());
    expect(again.limits.selfExclusion.liftEffectiveAt).toBe(sixMonths + 7 * DAY);
    // Still excluded through the cooling-off period, then not.
    expect((await s.limits(sixMonths + 7 * DAY - 1)).excluded).toBe(true);
    expect((await s.limits(sixMonths + 7 * DAY)).excluded).toBe(false);
  });

  it('asking for permanent again during the cooling-off cancels the lift', async () => {
    const s = await subject();
    await ok(await s.put(T0, { selfExclusion: 'permanent' }));
    const six = addMonths(T0, 6);
    expect((await s.lift(six)).status).toBe(200);
    const back = await ok(await s.put(six + DAY, { selfExclusion: 'permanent' }));
    expect(back).toMatchObject({
      excluded: true,
      selfExclusion: { permanent: true, liftRequestedAt: null, liftEffectiveAt: null },
    });
    expect((await s.limits(six + 30 * DAY)).excluded).toBe(true);
  });

  it('after a lift a new exclusion starts afresh', async () => {
    const s = await subject();
    await ok(await s.put(T0, { selfExclusion: 'permanent' }));
    const six = addMonths(T0, 6);
    await s.lift(six);
    const later = six + 8 * DAY;
    const fresh = await ok(await s.put(later, { selfExclusion: '7d' }));
    expect(fresh.selfExclusion).toEqual({
      startedAt: later,
      until: later + 7 * DAY,
      permanent: false,
      liftRequestedAt: null,
      liftEffectiveAt: null,
    });
  });
});

describe('the daily stake cap', () => {
  it('a decrease applies at once; an increase waits 24 hours; repeating it keeps the timer', async () => {
    const s = await subject();
    expect((await ok(await s.put(T0, { dailyStakeCap: String(40 * USDC) }))).dailyStakeCap).toBe(
      String(40 * USDC),
    );
    const raise = await ok(await s.put(T0 + HOUR, { dailyStakeCap: String(150 * USDC) }));
    expect(raise).toMatchObject({
      dailyStakeCap: String(40 * USDC),
      pendingCap: String(150 * USDC),
      pendingCapEffectiveAt: T0 + 25 * HOUR,
    });
    const same = await ok(await s.put(T0 + 2 * HOUR, { dailyStakeCap: String(150 * USDC) }));
    expect(same.pendingCapEffectiveAt).toBe(T0 + 25 * HOUR);
    const other = await ok(await s.put(T0 + 3 * HOUR, { dailyStakeCap: String(120 * USDC) }));
    expect(other.pendingCapEffectiveAt).toBe(T0 + 27 * HOUR);
    // A decrease drops the waiting raise.
    const down = await ok(await s.put(T0 + 4 * HOUR, { dailyStakeCap: String(30 * USDC) }));
    expect(down).toMatchObject({ dailyStakeCap: String(30 * USDC), pendingCap: null });
  });

  it('a raise that has waited out its 24 hours is the base for the next change', async () => {
    const s = await subject();
    await ok(await s.put(T0, { dailyStakeCap: String(10 * USDC) }));
    await ok(await s.put(T0, { dailyStakeCap: String(60 * USDC) }));
    // 25 hours later 60 is in force: 50 is a decrease, immediate.
    const down = await ok(await s.put(T0 + 25 * HOUR, { dailyStakeCap: String(50 * USDC) }));
    expect(down).toMatchObject({ dailyStakeCap: String(50 * USDC), pendingCap: null });
  });

  it('without a cap set, the default (100 USDC) is the base', async () => {
    const s = await subject();
    expect((await ok(await s.put(T0, { dailyStakeCap: String(90 * USDC) }))).pendingCap).toBeNull();
    const t = await subject();
    expect(await ok(await t.put(T0, { dailyStakeCap: String(110 * USDC) }))).toMatchObject({
      dailyStakeCap: String(100 * USDC),
      pendingCap: String(110 * USDC),
    });
  });

  it('both at once; and every change writes an audit row', async () => {
    const s = await subject();
    const both = await ok(
      await s.put(T0, { dailyStakeCap: String(5 * USDC), selfExclusion: '7d' }),
    );
    expect(both).toMatchObject({ dailyStakeCap: String(5 * USDC), excluded: true });
    const { results } = await env.DB.prepare(
      "SELECT action, actor_user_id FROM audit_log WHERE target = ?1 AND action = 'limits_set'",
    )
      .bind(s.id)
      .all();
    expect(results).toEqual([{ action: 'limits_set', actor_user_id: s.id }]);
  });
});

// W7-F1 R3 (owner decision B4, Oct 12): the cap is at most `limits.stakes.maxDailyCap`, 1,000 USDC
// per game day unless legal lowers it.
describe('the maximum daily cap', () => {
  const setMax = (value: unknown) =>
    env.DB.prepare(
      'INSERT INTO config (key, value_json, updated_at) VALUES (?1, ?2, 0) ' +
        'ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json',
    )
      .bind(MAX_DAILY_STAKE_CAP_KEY, JSON.stringify(value))
      .run();
  const clearMax = () =>
    env.DB.prepare('DELETE FROM config WHERE key = ?1').bind(MAX_DAILY_STAKE_CAP_KEY).run();

  it('PUT /me/limits refuses a cap above it (1,000 USDC unless lowered); GET /me reports it', async () => {
    const s = await subject();
    expect(await code(await s.put(T0, { dailyStakeCap: String(1_000 * USDC + 1) }))).toEqual([
      400,
      'bad_request',
    ]);
    expect(await ok(await s.put(T0, { dailyStakeCap: String(1_000 * USDC) }))).toMatchObject({
      pendingCap: String(1_000 * USDC),
    });
    expect((await s.limits(T0)).maxDailyCap).toBe(String(1_000 * USDC));

    // Legal lowers it to 500 USDC: 600 is refused, 500 is a raise like any other.
    await setMax(String(500 * USDC));
    try {
      expect(await code(await s.put(T0 + HOUR, { dailyStakeCap: String(600 * USDC) }))).toEqual([
        400,
        'bad_request',
      ]);
      expect(await ok(await s.put(T0 + HOUR, { dailyStakeCap: String(500 * USDC) }))).toMatchObject(
        { pendingCap: String(500 * USDC) },
      );
      expect((await s.limits(T0 + HOUR)).maxDailyCap).toBe(String(500 * USDC));
    } finally {
      await clearMax();
    }
  });

  it('unset, invalid or above 1,000 USDC, the key reads as 1,000 USDC', () => {
    const max = 1_000n * BigInt(USDC);
    expect(parseMaxDailyCap(null)).toBe(max);
    expect(parseMaxDailyCap('"250000000"')).toBe(250_000_000n);
    expect(parseMaxDailyCap('250000000')).toBe(250_000_000n);
    expect(parseMaxDailyCap('"0"')).toBe(0n);
    for (const bad of ['"abc"', '-5', '1.5', 'null', '{}', 'not json', '"1000000001"']) {
      expect(parseMaxDailyCap(bad)).toBe(max);
    }
  });
});

describe('suspended accounts', () => {
  it('may lower the cap and exclude themselves, but not raise the cap or lift an exclusion', async () => {
    const s = await subject();
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(s.id).run();
    await ok(await s.put(T0, { dailyStakeCap: String(20 * USDC) }));
    expect(await code(await s.put(T0, { dailyStakeCap: String(200 * USDC) }))).toEqual([
      403,
      'account_suspended',
    ]);
    await ok(await s.put(T0, { selfExclusion: 'permanent' }));
    expect(await code(await s.lift(addMonths(T0, 7)))).toEqual([403, 'account_suspended']);
  });
});

describe('one exclusion rule', () => {
  it('excludedSql (SQL) and limitsView (TypeScript) agree', async () => {
    const t = 1_000_000;
    const cases = [
      { until: null, permanent: 0, lift: null },
      { until: t + 1, permanent: 0, lift: null },
      { until: t, permanent: 0, lift: null },
      { until: t - 1, permanent: 0, lift: null },
      { until: null, permanent: 1, lift: null },
      { until: null, permanent: 1, lift: t + 1 },
      { until: null, permanent: 1, lift: t },
      { until: null, permanent: 1, lift: t - 1 },
      { until: t + 5, permanent: 1, lift: t - 1 },
    ];
    for (const [i, c] of cases.entries()) {
      const id = `rule-${i}`;
      await env.DB.prepare(
        'INSERT INTO limits (user_id, self_exclusion_until, self_exclusion_permanent, exclusion_lift_effective_at) VALUES (?1, ?2, ?3, ?4)',
      )
        .bind(id, c.until, c.permanent, c.lift)
        .run();
      const sql = await env.DB.prepare(`SELECT ${excludedSql('?1', '?2')} AS x`)
        .bind(id, t)
        .first<{ x: number }>();
      const ts = limitsView(
        {
          daily_stake_cap: null,
          pending_cap: null,
          pending_cap_effective_at: null,
          self_exclusion_started_at: null,
          self_exclusion_until: c.until,
          self_exclusion_permanent: c.permanent,
          exclusion_lift_requested_at: null,
          exclusion_lift_effective_at: c.lift,
          question_block_until: null,
        },
        t,
      ).excluded;
      expect([i, sql?.x === 1]).toEqual([i, ts]);
    }
  });
});
