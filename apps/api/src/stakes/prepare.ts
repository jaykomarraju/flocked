// `POST /rounds/:id/entries/stakes/prepare` (spec "Identity and personhood" › Entry tickets (Stakes);
// "Compliance and responsible play"; "Modes: Free and Stakes" flags). A ticket is issued only if
// every check passes, in this order (the first failure answers, with its own error code):
//   1. the kill switch `mode.stakes.enabled` is on (it stops tickets immediately; the signer checks
//      it again before signing, and its refusal answers `stakes_disabled` too);
//   then a room round is invisible outside its room: a non-member gets the unknown round's 404
//   before anything else about the round answers (spec "API" › Reveal gating; W6-F1 R10);
//   2. the round's Stakes mode exists, was created onchain and is open: `round_modes.status` is
//      `pending` and the RoundDO is open with no void requested (W4-Z carry-over: `round_modes`
//      alone misses a pending void);
//   3. `stakesEligibility` with fresh attestations: verified, country and request location allowed,
//      no proxy signal, age (21+ where `geo.stakes.age21` says) and ToS current, not self-excluded,
//      not suspended. Any linked wallet holding both attestations satisfies the country check, not
//      only the entering one (owner decision, Oct 12, 2026);
//   4. the entering wallet is a verified wallet linked to the user;
//   5. room rounds: the (member's) account is at least 24 hours older than closesAt;
//   6. the person has no Stakes entry in the round yet;
//   7. the round's stake fits in what is left of the daily cap for the round's game day, counting
//      indexed stakes, live tickets and unused ones the indexer has not processed past (O2;
//      src/stakes/cap.ts).
// Then issuance, serialised per person by one conditional insert: the row goes in only if the user
// holds no live ticket on that game day, and the person no live or used ticket in this round (W6-F1
// R13: a used one means an entry, maybe not indexed yet), so two concurrent requests issue one
// ticket. The committed row is what the signer checks before it signs; if the signer fails, the row
// is deleted again (no signature exists outside the signer, so nothing can use it; the delete is
// retried) and the request answers 503, or `stakes_disabled` when the signer saw the kill switch off.
//
// No person tag or person ID reaches a log (NFR-8).
import {
  INELIGIBLE_REASONS,
  LockedConfigSchema,
  gameDayOf,
  ticketDigest,
  type ErrorCode,
  type IneligibleReason,
  type StakesPrepareResponse,
} from '@flocked/shared';
import type { Address, Hex } from 'viem';
import { chainIdOf, deploymentOf } from '../chain/client.js';
import type { SessionUser } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import type { Env } from '../env.js';
import { readStakesConfig } from '../personhood/config-store.js';
import { stakesEligibility } from '../personhood/eligibility.js';
import { isRoomMember } from '../read/access.js';
import {
  TICKET_REISSUE_GRACE_SEC,
  TICKET_TTL_SEC,
  effectiveDailyCap,
  indexedThroughSec,
  stakedOnGameDay,
} from './cap.js';
import { personTag } from './person-tag.js';
import { ticketSigner } from './signer.js';

/** Room rounds: the account must exist this long before the round closes. */
export const ROOM_ACCOUNT_MIN_AGE_MS = 24 * 3600 * 1000;

interface RoundRow {
  id: string;
  kind: 'daily' | 'room';
  room_id: string | null;
  opens_at: number;
  closes_at: number;
  beacon_round: number | null;
  locked_at: number | null;
  config_json: string | null;
  stakes_status: string | null;
  chain_round_id: string | null;
}

/** The error code and message for each eligibility reason (the first reason answers). */
const REASON_ERRORS: Record<IneligibleReason, [ErrorCode, string]> = {
  not_verified: ['not_verified', 'Verify with Coinbase to play Stakes'],
  country_unverified: [
    'ineligible',
    "None of your wallets holds Coinbase's verified-country attestation",
  ],
  country_mismatch: [
    'ineligible',
    "Your wallets' attested country doesn't match your Coinbase country",
  ],
  geo_blocked: ['ineligible', "Stakes isn't available where you are"],
  proxy_detected: ['ineligible', "Stakes isn't available through a VPN, proxy or Tor"],
  age_unattested: ['tos_required', 'Confirm your age to play Stakes'],
  tos_not_accepted: ['tos_required', 'Accept the Stakes terms to play'],
  self_excluded: ['self_excluded', "You're self-excluded from play"],
  suspended: ['account_suspended', 'This account is suspended'],
  stakes_disabled: ['stakes_disabled', 'Stakes is paused'],
};

function ineligible(reasons: IneligibleReason[]): HttpError {
  const first = INELIGIBLE_REASONS.find((r) => reasons.includes(r)) ?? 'not_verified';
  const [code, message] = REASON_ERRORS[first];
  return new HttpError(code, message);
}

const unavailable = (what: string): HttpError => {
  log.error('stakes_config_missing', { var: what });
  return new HttpError('unavailable', 'Stakes tickets are unavailable right now');
};

async function loadRound(db: D1Database, roundId: string): Promise<RoundRow | null> {
  return db
    .prepare(
      'SELECT r.id, r.kind, r.room_id, r.opens_at, r.closes_at, r.beacon_round, r.locked_at, ' +
        'r.config_json, m.status AS stakes_status, m.chain_round_id FROM rounds r ' +
        "LEFT JOIN round_modes m ON m.round_id = r.id AND m.mode = 'stakes' WHERE r.id = ?1",
    )
    .bind(roundId)
    .first<RoundRow>();
}

/** The round's fixed Stakes stake (USDC base units) from its locked config, or null. */
function lockedStake(round: RoundRow): bigint | null {
  if (round.locked_at === null || round.config_json === null) return null;
  const parsed = LockedConfigSchema.safeParse(JSON.parse(round.config_json));
  return parsed.success && parsed.data.stakes ? BigInt(parsed.data.stakes.stake) : null;
}

/** Check 2: the Stakes mode is open, in D1 and in the RoundDO. */
async function requireOpenStakesMode(env: Env, round: RoundRow, t: number): Promise<void> {
  if (round.stakes_status === null || round.chain_round_id === null) {
    throw new HttpError('mode_unavailable', "Stakes isn't open in this round");
  }
  if (t < round.opens_at) throw new HttpError('round_not_open', "The round isn't open yet");
  if (t >= round.closes_at) throw new HttpError('round_closed', 'The round is closed');
  if (round.stakes_status !== 'pending') {
    throw new HttpError('mode_unavailable', "Stakes isn't open in this round");
  }
  let state;
  try {
    state = await env.ROUND.get(env.ROUND.idFromName(round.id)).getState();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('not_found')) {
      throw new HttpError('round_not_open', "The round isn't open yet");
    }
    throw err;
  }
  if (state.voidRequested) throw new HttpError('mode_unavailable', 'This round is being voided');
  if (state.status === 'closed') throw new HttpError('round_closed', 'The round is closed');
  if (state.status !== 'open') throw new HttpError('round_not_open', "The round isn't open yet");
  if ((state.modes.stakes?.status ?? 'pending') !== 'pending') {
    throw new HttpError('mode_unavailable', "Stakes isn't open in this round");
  }
}

/** Check 4: `wallet` is a verified wallet linked to the user. */
async function requireLinkedWallet(db: D1Database, userId: string, wallet: Address) {
  const linked = await db
    .prepare(
      "SELECT 1 AS ok FROM identities WHERE provider = 'wallet' AND external_id = ?1 AND user_id = ?2 " +
        'AND verified_at IS NOT NULL',
    )
    .bind(wallet, userId)
    .first();
  if (!linked) throw new HttpError('identity_required', 'Link this wallet to your account first');
}

/** Reveal gating: a room round answers a non-member as if it didn't exist. */
async function requireVisible(db: D1Database, round: RoundRow, userId: string): Promise<void> {
  if (round.kind !== 'room') return;
  if (round.room_id === null || !(await isRoomMember(db, round.room_id, userId))) {
    throw new HttpError('not_found', 'No such round');
  }
}

/** Check 5: room rounds (members, checked first) need an account 24 hours older than closesAt. */
function requireRoomAccountAge(round: RoundRow, createdAt: number) {
  if (createdAt > round.closes_at - ROOM_ACCOUNT_MIN_AGE_MS) {
    throw new HttpError(
      'ineligible',
      'Stakes in rooms needs an account made at least 24 hours before the round closes',
    );
  }
}

/** Check 6: no Stakes entry from this person in the round (indexed, or a used ticket). */
async function requireNoEntry(db: D1Database, roundId: string, userId: string, tag: Hex) {
  const entered = await db
    .prepare(
      "SELECT 1 AS ok FROM entries WHERE round_id = ?1 AND mode = 'stakes' AND (user_id = ?2 OR person_tag = ?3) " +
        'UNION ALL SELECT 1 FROM stakes_tickets WHERE round_id = ?1 AND person_tag = ?3 AND used_tx IS NOT NULL ' +
        'LIMIT 1',
    )
    .bind(roundId, userId, tag)
    .first();
  if (entered)
    throw new HttpError('already_entered', "You've already entered Stakes in this round");
}

/** Check 7: the stake fits in the rest of the game day's cap. */
async function requireCapRoom(
  db: D1Database,
  userId: string,
  round: RoundRow,
  gameDay: string,
  stake: bigint,
  t: number,
  escrow: { chainId: number; address: Address },
) {
  const throughSec = await indexedThroughSec(db, escrow.chainId, escrow.address);
  const [limits, staked] = await Promise.all([
    db
      .prepare(
        'SELECT daily_stake_cap, pending_cap, pending_cap_effective_at FROM limits WHERE user_id = ?1',
      )
      .bind(userId)
      .first<{
        daily_stake_cap: number | null;
        pending_cap: number | null;
        pending_cap_effective_at: number | null;
      }>(),
    stakedOnGameDay(db, userId, gameDay, round.id, Math.floor(t / 1000), throughSec),
  ]);
  if (staked + stake > effectiveDailyCap(limits, t)) {
    throw new HttpError('stake_cap_reached', "This stake would go over today's cap");
  }
}

/**
 * Records the ticket unless the user already holds a live one on `gameDay`, or the person a live or
 * used one in this round: one statement, so concurrent requests serialise on it. True when inserted.
 * Exported for tests.
 */
export async function insertTicket(
  db: D1Database,
  row: {
    ticketHash: Hex;
    roundId: string;
    personTag: Hex;
    userId: string;
    wallet: Address;
    expiry: number;
    issuedAt: number;
    gameDay: string;
  },
  nowSec: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      'INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at, game_day) ' +
        'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE NOT EXISTS (SELECT 1 FROM stakes_tickets ' +
        'WHERE (used_tx IS NULL AND expiry + ?10 > ?9 AND user_id = ?4 AND game_day = ?8) ' +
        'OR (round_id = ?2 AND person_tag = ?3 AND (used_tx IS NOT NULL OR expiry + ?10 > ?9)))',
    )
    .bind(
      row.ticketHash,
      row.roundId,
      row.personTag,
      row.userId,
      row.wallet,
      row.expiry,
      row.issuedAt,
      row.gameDay,
      nowSec,
      TICKET_REISSUE_GRACE_SEC,
    )
    .run();
  return res.meta.changes === 1;
}

/** The signer's refusal when it reads the kill switch off (apps/signer `ticket_refused: <reason>`). */
const SIGNER_DISABLED = 'ticket_refused: stakes_disabled';

/** Attempts at deleting a ticket row the signer didn't sign. */
export const DROP_TICKET_ATTEMPTS = 3;

/**
 * Deletes an unsigned ticket row, retried: a row left behind would block the user's next ticket
 * until it expires (+ 30 s) and hold its stake against the cap. A row that can't be deleted is
 * logged and left to expire; the request still answers its refusal.
 */
async function dropTicket(db: D1Database, roundId: string, ticketHash: Hex): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.prepare('DELETE FROM stakes_tickets WHERE ticket_hash = ?1').bind(ticketHash).run();
      return;
    } catch (err) {
      if (attempt >= DROP_TICKET_ATTEMPTS) {
        log.error('ticket_drop_failed', {
          roundId,
          attempts: attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
  }
}

/** Runs every check, records the ticket, has the signer sign it, and returns what `enter` needs. */
export async function prepareStakesTicket(
  env: Env,
  user: Pick<SessionUser, 'id'>,
  roundId: string,
  wallet: Address,
  request: Request,
): Promise<StakesPrepareResponse> {
  const db = env.DB;
  const t = now(env);
  const nowSec = Math.floor(t / 1000);

  const [round, config] = await Promise.all([loadRound(db, roundId), readStakesConfig(db)]);
  if (!config.stakesEnabled) throw new HttpError('stakes_disabled', 'Stakes is paused');
  if (!round) throw new HttpError('not_found', 'No such round');
  await requireVisible(db, round, user.id);
  const stake = lockedStake(round);
  if (stake === null || round.beacon_round === null) {
    throw new HttpError('mode_unavailable', "Stakes isn't open in this round");
  }
  await requireOpenStakesMode(env, round, t);
  const chainRoundId = round.chain_round_id as string;

  const eligibility = await stakesEligibility(env, user, request, { attestationMaxAgeMs: 0 });
  if (!eligibility.eligible) throw ineligible(eligibility.reasons);

  const person = await db
    .prepare('SELECT person_id, created_at FROM users WHERE id = ?1')
    .bind(user.id)
    .first<{ person_id: string | null; created_at: number }>();
  if (!person?.person_id) throw ineligible(['not_verified']);
  await requireLinkedWallet(db, user.id, wallet);
  if (round.kind === 'room') requireRoomAccountAge(round, person.created_at);

  const tag = await personTag(env, person.person_id, round.id);
  await requireNoEntry(db, round.id, user.id, tag);
  let chainId: number;
  let escrow: Address;
  try {
    chainId = chainIdOf(env);
    escrow = deploymentOf(env).escrow.toLowerCase() as Address;
  } catch {
    throw unavailable('LOCAL_DEPLOYMENT');
  }
  const gameDay = gameDayOf(Math.floor(round.closes_at / 1000));
  await requireCapRoom(db, user.id, round, gameDay, stake, t, { chainId, address: escrow });

  const signer = ticketSigner(env);
  const expiry = nowSec + TICKET_TTL_SEC;
  const ticketHash = ticketDigest(
    { chainId, verifyingContract: escrow },
    { roundId: BigInt(chainRoundId), wallet, personTag: tag, expiry: BigInt(expiry) },
  ).toLowerCase() as Hex;

  const inserted = await insertTicket(
    db,
    {
      ticketHash,
      roundId: round.id,
      personTag: tag,
      userId: user.id,
      wallet,
      expiry,
      issuedAt: t,
      gameDay,
    },
    nowSec,
  );
  if (!inserted) {
    // A used ticket for this round (an entry the indexer may not have seen yet) is an entry.
    await requireNoEntry(db, round.id, user.id, tag);
    throw new HttpError(
      'ticket_live',
      'You already have a live ticket today; try again once it has expired',
    );
  }

  let signature: Hex;
  try {
    ({ signature } = await signer.signTicket({
      roundId: chainRoundId,
      wallet,
      personTag: tag,
      expiry,
      ticketHash,
    }));
  } catch (err) {
    // Nobody but this request could hold a signature for the row, so dropping it is safe, and it
    // lets the user retry at once rather than after the ticket would have expired.
    await dropTicket(db, round.id, ticketHash);
    const error = err instanceof Error ? err.message : String(err);
    log.error('ticket_sign_failed', { roundId: round.id, error });
    // The kill switch went off between check 1 and the signer's own check.
    if (error.includes(SIGNER_DISABLED)) throw new HttpError('stakes_disabled', 'Stakes is paused');
    throw new HttpError('unavailable', 'Stakes tickets are unavailable right now');
  }
  log.info('stakes_ticket_issued', { roundId: round.id, gameDay });

  return {
    ticket: { roundId: chainRoundId, wallet, personTag: tag, expiry },
    signature,
    chainId,
    verifyingContract: escrow,
    stake: stake.toString(),
    beaconRound: round.beacon_round,
  };
}
