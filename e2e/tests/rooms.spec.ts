// Rooms end to end at the API level (W8-D; spec "Profiles, leaderboards and rooms" › Rooms, "API" ›
// Reveal gating). An owner creates a custom room and four players join it by invite code; its room
// round, which only the cron driver and the DOs' alarms move (lock, open, close, beacon, reveal,
// settlement), takes their Free picks in room points (500 to join, +100 per room round, the stake
// debited from the room balance) and settles. The room page then shows each member's pick and the
// leaderboard moved by exactly the payouts `@flocked/settle` computes in Node; the members-only room
// bundle flags each entrant as qualifying; and no global balance or public stat moved. Outside the
// room, the room, its round, the entry route and the bundle answer 401 anonymously and 404 to a
// signed-in non-member.
//
// A second custom room's round has exactly three entrants, one of them a fresh account: two
// qualifying entrants miss the room minimum (3), so it refunds by rule 1 and every stake goes back
// to the room balances.
//
// Seam calls are setup only: every stack account is new, so the qualifying accounts are backdated
// by 2 days (`POST /__test/users/age`), and each room round is scheduled with its question already
// the room's (`POST /__test/rounds/scheduled` with `roomId`, as `POST /rooms/:id/questions` would
// set it on the next daily slot's round). No anvil warp: Free needs none.
import { settle, type EntryInput } from '@flocked/settle';
import {
  gameDayOf,
  isoWeekOf,
  openGameDayAt,
  ROOM_MIN_QUALIFYING_ENTRANTS,
  type Room,
  type RoomDetailResponse,
  type RoundView,
} from '@flocked/shared';
import { expect, test, type User } from '../fixtures';
import {
  backdate,
  bundleEntries,
  bundleObject,
  createRoom,
  getRoom,
  joinRoom,
  roomDetail,
  verifyRound,
} from '../fixtures/rooms';
import {
  enterFree,
  myRound,
  postFreeEntry,
  scheduleRound,
  waitRound,
  type Pick,
} from '../fixtures/rounds';
import { auth, getMe, getProfile, setHandle } from '../fixtures/user';

const DAY_MS = 24 * 3_600_000;
/** The join grant (500 room points) and the room-round grant (+100) before the first stake. */
const JOIN_GRANT = 500n;
const ROUND_GRANT = 100n;

/** Room A: owner and four members. Option 0 is the minority (2 to 3), so it wins. */
const PICKS_A: Pick[] = [0, 1, 1, 0, 1];
const STAKES_A = [25n, 10n, 50n, 40n, 20n];
/** Room B: the owner, the first member and a fresh account; not one-sided, not a tie. */
const PICKS_B: Pick[] = [0, 1, 1];
const STAKES_B = [10n, 10n, 10n];

const code = (body: unknown) => (body as { error?: { code?: string } } | null)?.error?.code;

/** The member's row and leaderboard row on the room page. */
function rowsOf(detail: RoomDetailResponse, u: User) {
  const member = detail.members.find((m) => m.user.id === u.userId);
  const board = detail.leaderboard.find((r) => r.user.id === u.userId);
  if (!member || !board) throw new Error(`${u.userId} is not on the room page`);
  return { member, board };
}

test.describe.configure({ mode: 'serial' });

test.describe('rooms: a room round settles in room points, for members only', () => {
  let owner: User;
  const members: User[] = [];
  let outsider: User;
  let fresh: User;
  let roomA: Room;
  let roomB: Room;
  let roundA: string;
  let roundB: string;
  let openA: RoundView;
  let openB: RoundView;
  /** Room A's entrants, in PICKS_A order, and room B's. */
  let entrantsA: User[];
  let entrantsB: User[];
  /** userId → the receipt's userIdHash in each round (the bundle and settle account). */
  const accountsA = new Map<string, string>();
  const accountsB = new Map<string, string>();
  /** userId → global balance before any room play. */
  const globalBefore = new Map<string, string>();
  /** userId → handle (a new account has none, so no public profile, until it picks one). */
  const handles = new Map<string, string>();
  let seamCallsAfterSetup: number;

  test('setup: two custom rooms, members by invite code, backdated accounts, a round in each', async ({
    stack,
    clock,
    user,
  }) => {
    await clock.release();
    owner = await user();
    for (let i = 0; i < 4; i++) members.push(await user());
    outsider = await user();
    fresh = await user();
    entrantsA = [owner, ...members];
    entrantsB = [owner, members[0]!, fresh];

    roomA = await createRoom(stack, owner, { name: 'Flock A' });
    expect(roomA).toMatchObject({ ownerUserId: owner.userId, questionSource: 'custom' });
    for (const m of members) {
      expect((await joinRoom(stack, m, roomA.inviteCode)).id).toBe(roomA.id);
    }
    // Joining again returns the room without a second grant.
    expect((await joinRoom(stack, members[0]!, roomA.inviteCode)).memberCount).toBe(5);
    roomB = await createRoom(stack, owner, { name: 'Flock B' });
    await joinRoom(stack, members[0]!, roomB.inviteCode);
    await joinRoom(stack, fresh, roomB.inviteCode);

    // Everyone in room A qualifies; in room B, `fresh` stays a new account.
    for (const p of entrantsA) await backdate(stack, p, 2 * DAY_MS);
    for (const p of [...entrantsA, fresh]) {
      handles.set(p.userId, `rm-${p.userId.slice(-10).toLowerCase()}`);
      await setHandle(stack, p, handles.get(p.userId)!);
      globalBefore.set(p.userId, (await getMe(stack, p)).balances.global);
    }

    // Before any room round opens: 500 room points each, no current round, no picks.
    const detail = await roomDetail(stack, roomA.id, owner);
    expect(detail.room.memberCount).toBe(5);
    expect(detail.members.map((m) => m.user.id).sort()).toEqual(
      entrantsA.map((p) => p.userId).sort(),
    );
    expect(detail.members.find((m) => m.user.id === owner.userId)?.role).toBe('owner');
    for (const m of detail.members) expect(m.user.handle).toBe(handles.get(m.user.id));
    for (const m of detail.members) expect(m.balance).toBe(String(JOIN_GRANT));
    expect(detail.leaderboard.every((r) => r.rank === 1 && r.balance === String(JOIN_GRANT))).toBe(
      true,
    );
    expect(detail.currentRound).toBeNull();
    expect(detail.memberPicks).toBeNull();

    // Both rounds on the same clock, each in its own room.
    const timing = { opensInMs: 20_000, openForMs: 60_000, beaconDelay: 60 };
    ({ roundId: roundA } = await scheduleRound(stack, {
      ...timing,
      roomId: roomA.id,
      prompt: 'Sheep or goats, room A?',
    }));
    ({ roundId: roundB } = await scheduleRound(stack, {
      ...timing,
      roomId: roomB.id,
      prompt: 'Sheep or goats, room B?',
    }));
    seamCallsAfterSetup = stack.seamCalls;
  });

  test('the scheduler locks and opens both room rounds; outside the room nothing answers', async ({
    stack,
  }) => {
    openA = await waitRound(
      stack,
      roundA,
      'room A to open',
      90_000,
      (r) => r.status === 'open',
      owner,
    );
    openB = await waitRound(
      stack,
      roundB,
      'room B to open',
      60_000,
      (r) => r.status === 'open',
      owner,
    );
    for (const [open, room] of [
      [openA, roomA],
      [openB, roomB],
    ] as const) {
      expect(open).toMatchObject({ kind: 'room', roomId: room.id });
      expect(open.modes.free?.status).toBe('pending');
      expect(open.modes.stakes).toBeUndefined();
      // The room minimum, locked; rooms pay no creator award.
      expect(open.config?.free).toMatchObject({
        minEntrants: ROOM_MIN_QUALIFYING_ENTRANTS,
        awardRecipient: null,
      });
    }
    expect(openA.question.prompt).toBe('Sheep or goats, room A?');

    // The room: anonymous 401, a signed-in non-member 404 (as for an unknown room).
    const anonRoom = await getRoom(stack, roomA.id);
    expect([anonRoom.status, code(anonRoom.body)]).toEqual([401, 'unauthorized']);
    const outRoom = await getRoom(stack, roomA.id, outsider);
    expect([outRoom.status, code(outRoom.body)]).toEqual([404, 'not_found']);
    // A member of room A only is an outsider to room B.
    const onlyInA = members[1]!;
    expect((await getRoom(stack, roomB.id, onlyInA)).status).toBe(404);

    // Its round: the same answers on every read, and the entry route refuses the non-member.
    const anonRound = await stack.api(`/rounds/${roundA}`);
    expect([anonRound.status, code(anonRound.body)]).toEqual([401, 'unauthorized']);
    const outRound = await stack.api(`/rounds/${roundA}`, auth(outsider));
    expect([outRound.status, code(outRound.body)]).toEqual([404, 'not_found']);
    expect((await stack.api(`/rounds/${roundA}/me`, auth(outsider))).status).toBe(404);
    const outEntry = await postFreeEntry(stack, outsider, openA, 0, 10n);
    expect([outEntry.status, code(outEntry.body)]).toEqual([404, 'not_found']);
    expect((await postFreeEntry(stack, onlyInA, openB, 0, 10n)).status).toBe(404);
  });

  test('members enter Free; the stake comes from the room balance, never the global one', async ({
    stack,
  }) => {
    for (const [i, p] of entrantsA.entries()) {
      await enterFree(stack, p, openA, PICKS_A[i]!, STAKES_A[i]);
    }
    for (const [i, p] of entrantsB.entries()) {
      await enterFree(stack, p, openB, PICKS_B[i]!, STAKES_B[i]);
    }
    expect(Date.now()).toBeLessThan(openA.closesAt * 1000);

    for (const [round, entrants, accounts] of [
      [roundA, entrantsA, accountsA],
      [roundB, entrantsB, accountsB],
    ] as const) {
      for (const p of entrants) {
        const receipt = (await myRound(stack, round, p)).modes.free?.receipt;
        expect(receipt, p.userId).toBeTruthy();
        accounts.set(p.userId, receipt!.userIdHash);
      }
    }

    // 500 to join + 100 for the round − the stake, per room; the global balance is untouched.
    const detailA = await roomDetail(stack, roomA.id, owner);
    expect(detailA.currentRound).toMatchObject({ id: roundA, status: 'open' });
    for (const [i, p] of entrantsA.entries()) {
      expect(rowsOf(detailA, p).member.balance, p.userId).toBe(
        String(JOIN_GRANT + ROUND_GRANT - STAKES_A[i]!),
      );
    }
    const detailB = await roomDetail(stack, roomB.id, owner);
    for (const [i, p] of entrantsB.entries()) {
      expect(rowsOf(detailB, p).member.balance, p.userId).toBe(
        String(JOIN_GRANT + ROUND_GRANT - STAKES_B[i]!),
      );
    }
    for (const p of [...entrantsA, fresh]) {
      const me = await getMe(stack, p);
      expect(me.balances.global, p.userId).toBe(globalBefore.get(p.userId));
      const a = entrantsA.indexOf(p);
      const b = entrantsB.indexOf(p);
      const rooms = new Map(me.balances.rooms.map((r) => [r.roomId, r.balance]));
      if (a >= 0) expect(rooms.get(roomA.id)).toBe(String(JOIN_GRANT + ROUND_GRANT - STAKES_A[a]!));
      if (b >= 0) expect(rooms.get(roomB.id)).toBe(String(JOIN_GRANT + ROUND_GRANT - STAKES_B[b]!));
    }

    await waitRound(
      stack,
      roundA,
      'room A to count its entrants',
      30_000,
      (r) => r.modes.free?.entrantCount === entrantsA.length,
      owner,
    );
  });

  test('room A reveals and settles on its own; the room page shows the picks and the payouts', async ({
    stack,
  }) => {
    const settled = await waitRound(
      stack,
      roundA,
      'room A to settle',
      300_000,
      (r) => r.modes.free?.status === 'settled',
      owner,
    );
    const free = settled.modes.free!;
    expect(free.revealedAt).toBeGreaterThanOrEqual(settled.beaconTime * 1000);
    expect(free.settlement).toMatchObject({ outcome: 'settled', winningOption: 0 });
    const heads = (o: 0 | 1) => PICKS_A.filter((p) => p === o).length;
    expect(free.settlement!.tally.map((t) => t.headcount)).toEqual([heads(0), heads(1)]);

    // The payouts @flocked/settle computes from the picks, every entrant qualifying.
    const cfg = settled.config!.free!;
    const inputs: EntryInput[] = entrantsA.map((p, i) => ({
      account: accountsA.get(p.userId)!,
      stake: STAKES_A[i]!,
      option: PICKS_A[i]!,
      voidReason: null,
      qualifies: true,
    }));
    const { record, payouts } = settle(inputs, {
      feeBps: cfg.feeBps,
      creatorBps: cfg.creatorBps,
      capMultiple: cfg.capMultiple,
      minEntrants: cfg.minEntrants,
      creatorAwardBps: 0,
      countQualifyingOnly: true,
    });
    expect(record.outcome).toBe('settled');
    expect(free.settlement!.lossPool).toBe(String(record.lossPool));
    expect(free.settlement!.dust).toBe(String(record.dust));
    const paid = (account: string) =>
      payouts.filter((x) => x.account === account).reduce((s, x) => s + x.amount, 0n);

    const detail = await roomDetail(stack, roomA.id, owner);
    expect(detail.currentRound).toMatchObject({ id: roundA });
    // Member picks, after the reveal.
    expect(detail.memberPicks?.roundId).toBe(roundA);
    expect(new Map(detail.memberPicks!.picks.map((x) => [x.user.id, x.option]))).toEqual(
      new Map(entrantsA.map((p, i) => [p.userId, PICKS_A[i]])),
    );

    // Balances moved by exactly the payouts: winners up, losers down; ranks follow the balances.
    const sameWeek =
      isoWeekOf(gameDayOf(settled.closesAt)) ===
      isoWeekOf(openGameDayAt(Math.floor(Date.now() / 1000)));
    for (const [i, p] of entrantsA.entries()) {
      const want = JOIN_GRANT + ROUND_GRANT - STAKES_A[i]! + paid(accountsA.get(p.userId)!);
      const { member, board } = rowsOf(detail, p);
      expect(member.balance, p.userId).toBe(String(want));
      expect(board.balance, p.userId).toBe(String(want));
      const won = PICKS_A[i] === 0;
      if (won) expect(want).toBeGreaterThan(JOIN_GRANT + ROUND_GRANT);
      else expect(want).toBeLessThan(JOIN_GRANT + ROUND_GRANT);
      expect(board.streak, p.userId).toBe(won ? 1 : 0);
      expect(board.winsThisWeek, p.userId).toBe(won && sameWeek ? 1 : 0);
      expect((await myRound(stack, roundA, p)).modes.free?.result).toBe(won ? 'win' : 'loss');
    }
    const balances = detail.leaderboard.map((r) => BigInt(r.balance));
    expect(balances).toEqual([...balances].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0)));
    expect(detail.leaderboard[0]!.rank).toBe(1);

    // The room bundle (members only) flags every backdated entrant as qualifying.
    const entries = await bundleEntries(stack, roundA, 'free', owner);
    expect(entries).toHaveLength(entrantsA.length);
    const flags = new Map(entries.map((e) => [e.account, e.qualifies]));
    for (const p of entrantsA) expect(flags.get(accountsA.get(p.userId)!), p.userId).toBe(true);
    const verify = await verifyRound(stack, roundA, owner);
    const manifest = await bundleObject(stack, verify.modes.free!.manifestUrl, owner);
    expect(manifest.body).toMatchObject({ kind: 'room', roomId: roomA.id });
    // ...and is invisible outside the room.
    expect((await stack.api(`/rounds/${roundA}/verify`)).status).toBe(401);
    expect((await stack.api(`/rounds/${roundA}/verify`, auth(outsider))).status).toBe(404);
    expect((await bundleObject(stack, verify.modes.free!.manifestUrl)).status).toBe(401);
    expect((await bundleObject(stack, verify.modes.free!.chunkUrls[0]!, outsider)).status).toBe(
      404,
    );
  });

  test('room B misses the room minimum (a fresh account does not qualify) and refunds by rule 1', async ({
    stack,
  }) => {
    const refunded = await waitRound(
      stack,
      roundB,
      'room B to refund',
      120_000,
      (r) => r.modes.free?.status === 'refunded',
      owner,
    );
    const free = refunded.modes.free!;
    expect(free.refundReason).toBe(1);
    expect(free.settlement).toMatchObject({ outcome: 'refunded', winningOption: null });
    expect(free.entrantCount).toBe(entrantsB.length);

    const entries = await bundleEntries(stack, roundB, 'free', owner);
    const flags = new Map(entries.map((e) => [e.account, e.qualifies]));
    expect(entrantsB.map((p) => flags.get(accountsB.get(p.userId)!))).toEqual([true, true, false]);

    // Every stake back: 500 + 100 in room B, and room A as it settled.
    const detail = await roomDetail(stack, roomB.id, owner);
    for (const p of entrantsB) {
      expect(rowsOf(detail, p).member.balance, p.userId).toBe(String(JOIN_GRANT + ROUND_GRANT));
      expect((await myRound(stack, roundB, p)).modes.free?.result).toBe('refund');
    }
    // Refunded rounds are neutral for streaks.
    expect(detail.leaderboard.every((r) => r.streak === 0 && r.winsThisWeek === 0)).toBe(true);
  });

  test('room play moved no global balance or public stat, and no seam call followed the setup', async ({
    stack,
  }) => {
    for (const p of [...entrantsA, fresh]) {
      expect((await getMe(stack, p)).balances.global, p.userId).toBe(globalBefore.get(p.userId));
      // Public stats and recent results count daily rounds only.
      const profile = await getProfile(stack, handles.get(p.userId)!);
      expect(
        profile.stats.filter((x) => x.roundsPlayed > 0 || x.wins > 0 || x.refunds > 0),
        p.userId,
      ).toEqual([]);
      expect(profile.recent, p.userId).toEqual([]);
    }
    expect(stack.seamCalls).toBe(seamCallsAfterSetup);
  });
});
