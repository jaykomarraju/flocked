// GET /users/:handle (spec "Profiles, leaderboards and rooms" › Profiles): stats per mode with the
// Stakes net private unless opted in, authored questions with split quality (no unopened round's
// question), final recent results, and no profile for deleted or merged accounts.
import { env } from 'cloudflare:test';
import { UserProfileResponseSchema } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { users } from '../../src/routes/users.js';
import { applyFinalDays } from '../../src/stats/apply.js';
import { withFixedClock, withSession } from '../helpers/index.js';
import { finalizeMode, resetTables, seedDay, seedUser, userId } from './helpers.js';

const u = userId;
const app = withSession(users);
const get = (path: string) => app.request(path, {}, withFixedClock(env, Date.UTC(2026, 9, 9, 12)));

beforeAll(async () => {
  await resetTables();
  await seedUser(1, { handle: 'woolly', displayName: 'Woolly' });
  await seedUser(2, { handle: 'shown', prefs: { show_stakes_net: true } });
  await seedUser(3, { handle: 'gone', status: 'deleted' });
  await seedUser(4, { handle: 'merged', status: 'merged' });
  await seedUser(5, { handle: 'quiet', status: 'suspended' });
  const both = (d: string, w1: 0 | 1) =>
    seedDay({
      day: d,
      author: u(1),
      modes: {
        free: {
          status: 'settled',
          winner: 0,
          entries: [
            { user: u(1), option: w1 },
            { user: u(2), option: 1 },
            { user: u(9), option: 1 },
          ],
        },
        stakes: {
          status: 'settled',
          winner: 0,
          entries: [
            { user: u(1), option: w1, stake: 5_000_000, payout: w1 === 0 ? 9_000_000 : 0 },
            { user: u(2), option: 1, stake: 5_000_000, payout: 0 },
          ],
        },
      },
    });
  await both('2026-10-05', 0);
  await both('2026-10-06', 1);
  // A refunded day and one whose Free mode is still revealing (not a result yet).
  await seedDay({
    day: '2026-10-07',
    modes: { free: { status: 'refunded', entries: [{ user: u(1), option: 0, payout: 100 }] } },
  });
  const late = await seedDay({
    day: '2026-10-08',
    modes: { free: { status: 'revealing', entries: [{ user: u(1), option: 0 }] } },
  });
  await applyFinalDays(env.DB, 'free', Date.UTC(2026, 9, 9));
  await applyFinalDays(env.DB, 'stakes', Date.UTC(2026, 9, 9));
  void late;
  // Authored: a queued question (public), a used question whose round has not opened (hidden) and
  // a scheduled one (hidden).
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at)
       VALUES (?1, ?2, 'Queued?', '[{"label":"A","emoji":"🅰️"},{"label":"B","emoji":"🅱️"}]', 'food', 'queued', 1)`,
    ).bind('01K8Q000000000000000000900', u(1)),
    env.DB.prepare(
      `INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at)
       VALUES (?1, ?2, 'Scheduled?', '[{"label":"A","emoji":"🅰️"},{"label":"B","emoji":"🅱️"}]', 'food', 'scheduled', 2)`,
    ).bind('01K8Q000000000000000000901', u(1)),
  ]);
  await seedDay({
    day: '2026-10-20',
    author: u(1),
    modes: { free: { status: 'pending', entries: [] } },
  });
});

describe('GET /users/:handle', () => {
  it('shows stats per mode, with the Stakes net hidden unless the user shows it', async () => {
    const res = await get('/users/woolly');
    expect(res.status).toBe(200);
    const p = UserProfileResponseSchema.parse(await res.json());
    expect(p.user).toMatchObject({ id: u(1), handle: 'woolly', displayName: 'Woolly' });
    expect(p.stats).toEqual([
      {
        mode: 'free',
        roundsPlayed: 3,
        wins: 1,
        losses: 1,
        refunds: 1,
        strayStreak: 0,
        bestStrayStreak: 1,
        playStreak: 3,
        net: '0',
      },
      {
        mode: 'stakes',
        roundsPlayed: 2,
        wins: 1,
        losses: 1,
        refunds: 0,
        strayStreak: 0,
        bestStrayStreak: 1,
        playStreak: 2,
        net: null,
      },
    ]);
    const shown = UserProfileResponseSchema.parse(await (await get('/users/shown')).json());
    expect(shown.stats.find((s) => s.mode === 'stakes')?.net).toBe('-10000000');
  });

  it('lists final results only, newest first', async () => {
    const p = UserProfileResponseSchema.parse(await (await get('/users/woolly')).json());
    expect(p.recent.map((r) => [r.gameDay, r.mode, r.result])).toEqual([
      ['2026-10-07', 'free', 'refund'],
      ['2026-10-06', 'free', 'loss'],
      ['2026-10-06', 'stakes', 'loss'],
      ['2026-10-05', 'free', 'win'],
      ['2026-10-05', 'stakes', 'win'],
    ]);
  });

  it('lists queued and opened used questions with split quality, never an unopened round', async () => {
    const p = UserProfileResponseSchema.parse(await (await get('/users/woolly')).json());
    // Newest first. Free on 10-06 went 0 v 3 (split 0), on 10-05 1 v 2 (2/3).
    expect(p.questions.map((q) => [q.prompt, q.status])).toEqual([
      ['Question 2?', 'used'],
      ['Question 1?', 'used'],
      ['Queued?', 'queued'],
    ]);
    expect(p.questions.map((q) => q.splitQuality)).toEqual([0, expect.closeTo(2 / 3, 10), null]);
  });

  it('answers 404 for deleted, merged and unknown accounts; a suspended one is still public', async () => {
    for (const h of ['gone', 'merged', 'nobody']) {
      const res = await get(`/users/${h}`);
      expect(res.status).toBe(404);
    }
    expect((await get('/users/quiet')).status).toBe(200);
    // Handles are lowercase (HandleSchema).
    expect((await get('/users/x')).status).toBe(400);
    expect((await get('/users/Woolly')).status).toBe(400);
  });

  it('counts a late mode once it is final', async () => {
    const r = await env.DB.prepare(
      "SELECT id FROM rounds WHERE closes_at = (SELECT MAX(closes_at) FROM rounds WHERE id IN (SELECT round_id FROM round_modes WHERE status = 'revealing'))",
    ).first<{ id: string }>();
    await finalizeMode(r?.id ?? '', 'free', 'settled', 1);
    await applyFinalDays(env.DB, 'free', Date.UTC(2026, 9, 10));
    const p = UserProfileResponseSchema.parse(await (await get('/users/woolly')).json());
    expect(p.recent[0]).toMatchObject({ gameDay: '2026-10-08', result: 'loss' });
    expect(p.stats[0]).toMatchObject({ roundsPlayed: 4, losses: 2 });
  });
});
