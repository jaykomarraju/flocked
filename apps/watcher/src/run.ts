// One watcher tick (wrangler.jsonc: every minute). It
//   1. snapshots the config of every round it can see whose question has locked, write-once;
//   2. checks each tracked round's `RoundCreated` against that snapshot and the backend-independent
//      rules (src/rules.ts);
//   3. records every `OutcomeProposed` log and verifies it by full recompute (`@flocked/verify`);
//   4. checks the routes into Refunded that no proposal explains: void, refundTooFew and timeout;
//   5. pages the guardian on a mismatch, on unable, and on a proposal still without a verdict 30
//      minutes on;
//   6. delivers the queued pages.
// Every step is per round and wrapped, so one unreachable round never stops the others.
import type { Address, Hex } from 'viem';
import type { PublishedRound } from './api.js';
import type { RoundCreatedLog } from './chain.js';
import {
  getRoundState,
  getVerdict,
  markMissingPaged,
  proposalsFor,
  putProposal,
  putSnapshot,
  putVerdict,
  setRoundState,
  trackedRounds,
  unpagedProposals,
  verdictSubjects,
  type ProposalRow,
  type RoundSnapshot,
} from './db.js';
import { decide, fromReportVerdict, reasonOf } from './decide.js';
import type { WatcherDeps } from './deps.js';
import type { Env } from './env.js';
import {
  MISSING_VERDICT_MS,
  flushPages,
  queueMissingVerdictPage,
  queueVerdictPage,
} from './page.js';
import { checkRoundCreated } from './rules.js';
import { Checks } from '@flocked/verify';
import {
  pages,
  signVerdict,
  watcherKey,
  type Verdict,
  type VerdictSubject,
  type VerdictValue,
} from './verdict.js';

/** How far back a round stays tracked. */
export const TRACK_WINDOW_SEC = 7 * 24 * 60 * 60;
/** How many tracked rounds one tick works through. */
export const TRACK_LIMIT = 20;
/** Closed rounds the archive is asked for each tick, so a restart catches up. */
export const ARCHIVE_LOOKBACK = 5;
/** An unresolved `RoundCreated` check is published as `unable` this long before close, so the
 *  guardian still has time to `voidRound`. */
export const ROUND_VERDICT_DEADLINE_MS = 15 * 60 * 1000;
/** An unresolved refund check is published as `unable` this long after the refund. */
export const REFUND_VERDICT_DEADLINE_MS = 30 * 60 * 1000;

export interface TickSummary {
  snapshots: number;
  verdicts: { subject: VerdictSubject; roundId: string; verdict: VerdictValue }[];
  paged: number;
  delivered: number;
  failed: number;
  errors: string[];
}

function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
  console[level === 'info' ? 'log' : level](JSON.stringify({ level, event, ...fields }));
}

/**
 * A published round as a snapshot, or null when there is nothing final to snapshot yet: before the
 * question locks, or while a Stakes mode still publishes `chainRoundId` "0" (the escrow round has
 * not been created). The snapshot is write-once, so it is only taken once it is complete.
 */
export function snapshotOf(r: PublishedRound, now: number): RoundSnapshot | null {
  if (!r.config) return null;
  const chainRoundId = r.config.stakes?.chainRoundId ?? null;
  if (r.config.stakes && (chainRoundId === null || chainRoundId === '0')) return null;
  return {
    roundId: r.id,
    gameDay: r.gameDay,
    kind: r.kind,
    roomId: r.roomId,
    opensAt: r.opensAt,
    closesAt: r.closesAt,
    beaconRound: r.beaconRound,
    beaconDelay: r.config.beaconDelay,
    chainRoundId,
    isHouse: r.question.author === null,
    config: r.config,
    snapshotAt: now,
  };
}

/**
 * Snapshots every round the public API shows: the open one, the previous one while it is still
 * revealing, and the most recent closed ones (so a watcher that was down still verifies them, with
 * `snapshot.independent` recording that the snapshot came late).
 */
export async function snapshotRounds(
  env: Env,
  deps: WatcherDeps,
  now: number,
  errors: string[],
): Promise<number> {
  const rounds: PublishedRound[] = [];
  const ids = new Set<string>();
  try {
    const today = await deps.api.today();
    if (today.round) rounds.push(today.round);
    if (today.previousRoundId) ids.add(today.previousRoundId);
    for (const id of await deps.api.recentRoundIds(ARCHIVE_LOOKBACK)) ids.add(id);
  } catch (e) {
    errors.push(`api: ${(e as Error).message}`);
  }
  for (const id of ids) {
    if (rounds.some((r) => r.id === id)) continue;
    // A round already snapshotted never needs reading again: the snapshot is write-once.
    try {
      const existing = await env.DB.prepare('SELECT 1 FROM round_snapshots WHERE round_id = ?1')
        .bind(id)
        .first();
      if (existing) continue;
      const r = await deps.api.round(id);
      if (r) rounds.push(r);
    } catch (e) {
      errors.push(`api /rounds/${id}: ${(e as Error).message}`);
    }
  }
  let written = 0;
  for (const r of rounds) {
    const s = snapshotOf(r, now);
    if (!s) continue;
    if (await putSnapshot(env.DB, s)) {
      written += 1;
      log('info', 'round_snapshotted', {
        roundId: s.roundId,
        chainRoundId: s.chainRoundId,
        closesAt: s.closesAt,
      });
    }
  }
  return written;
}

interface PublishInput {
  env: Env;
  key: Hex;
  subject: VerdictSubject;
  roundId: string;
  checks: Checks;
  now: number;
  /** When false, an `unable` is kept back and the check runs again next tick. */
  deadlinePassed: boolean;
}

/**
 * Signs, stores and (unless it is a match) pages one verdict. An `unable` before its deadline is
 * not published: the checks run again next tick, so a slow RPC does not freeze a round at `unable`.
 */
async function publish(i: PublishInput): Promise<Verdict | null> {
  const { verdict, reasons } = decide(i.checks);
  if (verdict === 'unable' && !i.deadlinePassed) return null;
  const signed = await signVerdict(i.key, {
    subject: i.subject,
    roundId: i.roundId,
    mode: 'stakes',
    verdict,
    reasons,
    checkedAt: i.now,
  });
  const stored = await putVerdict(i.env.DB, signed);
  if (!stored) return getVerdict(i.env.DB, i.subject, i.roundId);
  log(verdict === 'match' ? 'info' : 'error', 'verdict', {
    subject: i.subject,
    roundId: i.roundId,
    verdict,
    reasons: reasons.filter((r) => !r.startsWith('pass ')),
  });
  if (pages(verdict)) await queueVerdictPage(i.env.DB, signed, i.now);
  return signed;
}

/** The `RoundCreated` check for one snapshotted round. */
async function checkCreated(
  env: Env,
  deps: WatcherDeps,
  key: Hex,
  snap: RoundSnapshot,
  now: number,
): Promise<VerdictValue | null> {
  const stakes = snap.config.stakes;
  if (!stakes || snap.chainRoundId === null) return null;
  const state = await getRoundState(env.DB, snap.roundId);
  const id = BigInt(snap.chainRoundId);
  const deadlinePassed = now >= snap.closesAt * 1000 - ROUND_VERDICT_DEADLINE_MS;
  let read: { created: RoundCreatedLog | null; treasury: Address };
  try {
    const [created, treasury] = await Promise.all([
      deps.chain.roundCreated(
        id,
        state.createdBlock === null ? undefined : BigInt(state.createdBlock),
      ),
      deps.chain.treasury(),
    ]);
    read = { created, treasury };
  } catch (e) {
    const failed = new Checks();
    failed.error('created.chain', `the chain read failed: ${(e as Error).message}`);
    const v = await publish({
      env,
      key,
      subject: 'stakes_round',
      roundId: snap.roundId,
      checks: failed,
      now,
      deadlinePassed,
    });
    return v?.verdict ?? null;
  }
  const { created, treasury } = read;
  if (created && state.createdBlock === null) {
    await setRoundState(env.DB, snap.roundId, { createdBlock: Number(created.blockNumber) });
  }
  const checks = await checkRoundCreated({
    snapshot: snap,
    published: snap.config,
    stakes,
    created,
    treasury,
    drand: deps.drand,
    countryAllow: deps.countryAllow,
    attestations: deps.attestations,
    nowSec: BigInt(Math.floor(now / 1000)),
  });
  const v = await publish({
    env,
    key,
    subject: 'stakes_round',
    roundId: snap.roundId,
    checks,
    now,
    deadlinePassed,
  });
  return v?.verdict ?? null;
}

/** Records every `OutcomeProposed` log this watcher has not seen before. */
async function observeProposals(
  env: Env,
  deps: WatcherDeps,
  snap: RoundSnapshot,
  now: number,
): Promise<void> {
  if (snap.chainRoundId === null) return;
  const state = await getRoundState(env.DB, snap.roundId);
  const from = BigInt(state.createdBlock ?? Number(deps.deployment.deployBlock));
  const logs = await deps.chain.proposed(BigInt(snap.chainRoundId), from);
  const known = new Set((await proposalsFor(env.DB, snap.roundId)).map((p) => p.bundleHash));
  for (const l of logs) {
    if (known.has(l.bundleHash)) continue;
    const at = await deps.chain.blockTime(l.blockNumber);
    if (at === null) continue;
    await putProposal(env.DB, {
      roundId: snap.roundId,
      chainRoundId: snap.chainRoundId,
      bundleHash: l.bundleHash,
      txHash: l.txHash,
      blockNumber: Number(l.blockNumber),
      proposedAt: at,
      seenAt: now,
    });
    log('info', 'proposal_seen', {
      roundId: snap.roundId,
      bundleHash: l.bundleHash,
      txHash: l.txHash,
      proposedAt: at,
    });
  }
}

/** The full recompute of a round's Stakes proposal, through `@flocked/verify`. */
async function checkProposal(
  env: Env,
  deps: WatcherDeps,
  key: Hex,
  snap: RoundSnapshot,
  proposal: ProposalRow,
  now: number,
): Promise<VerdictValue | null> {
  const checks = new Checks();
  let verdict: VerdictValue;
  let reasons: string[];
  try {
    const report = await deps.verify({
      rpcUrl: deps.rpcUrl,
      chainId: deps.chainId,
      roundId: snap.roundId,
      mode: 'stakes',
      bundleBaseUrl: deps.bundleBaseUrl,
      drand: deps.drand,
      addresses: deps.deployment,
      reader: deps.reader,
    });
    verdict = fromReportVerdict(report.verdict);
    reasons = report.checks.map(reasonOf);
    // The bundle the recompute matched must be the one this proposal posted.
    if (report.bundleHash !== null && report.bundleHash !== proposal.bundleHash) {
      verdict = 'mismatch';
      reasons = [
        `fail proposal.bundle: the published bundle is not the one this proposal posted (published/expected ${proposal.bundleHash}, onchain/actual ${report.bundleHash})`,
        ...reasons,
      ];
    }
  } catch (e) {
    checks.error('verify', `the recompute could not run: ${(e as Error).message}`);
    ({ verdict, reasons } = decide(checks));
  }
  const deadlinePassed = now >= proposal.proposedAt * 1000 + MISSING_VERDICT_MS;
  if (verdict === 'unable' && !deadlinePassed) return null;
  const signed = await signVerdict(key, {
    subject: 'stakes_proposal',
    roundId: snap.roundId,
    mode: 'stakes',
    verdict,
    reasons,
    checkedAt: now,
  });
  if (await putVerdict(env.DB, signed)) {
    log(verdict === 'match' ? 'info' : 'error', 'verdict', {
      subject: 'stakes_proposal',
      roundId: snap.roundId,
      verdict,
      bundleHash: proposal.bundleHash,
      reasons: reasons.filter((r) => !r.startsWith('pass ')),
    });
    if (pages(verdict)) await queueVerdictPage(env.DB, signed, now);
  }
  return verdict;
}

/** Void, `refundTooFew` and timeout: the routes into Refunded that no proposal explains. */
async function checkRefund(
  env: Env,
  deps: WatcherDeps,
  key: Hex,
  snap: RoundSnapshot,
  now: number,
): Promise<VerdictValue | null> {
  if (snap.chainRoundId === null) return null;
  const id = BigInt(snap.chainRoundId);
  const state = await getRoundState(env.DB, snap.roundId);
  const from = BigInt(state.createdBlock ?? Number(deps.deployment.deployBlock));
  const checks = new Checks();
  let refundedAt = state.refundedAt;
  try {
    const refunds = await deps.chain.roundRefunded(id, from);
    const last = refunds[refunds.length - 1];
    // Reasons 2, 3 and 5 came from a proposal or a guardian veto: `stakes_proposal` covers them.
    if (!last || last.reason === 2 || last.reason === 3 || last.reason === 5) return null;
    const at = refundedAt ?? (await deps.chain.blockTime(last.blockNumber));
    if (at !== null && refundedAt === null) {
      refundedAt = at;
      await setRoundState(env.DB, snap.roundId, { refundedAt: at });
    }
    const round = await deps.chain.round(id);
    const closesAt = Number(round.cfg.closesAt);
    checks.equal(
      'refund.reason',
      'the RoundRefunded reason and the escrow round agree',
      String(round.refundReason),
      String(last.reason),
    );
    if (at === null) {
      checks.error('refund.time', `block ${last.blockNumber} is not readable on this RPC`);
    } else if (last.reason === 1) {
      checks.equal(
        'refund.tooFew',
        `refundTooFew needs entryCount < minEntrants (${round.entryCount} < ${round.cfg.minEntrants})`,
        'true',
        String(round.entryCount < round.cfg.minEntrants),
      );
      checks.equal(
        'refund.time',
        'refundTooFew is callable only after close',
        'true',
        String(at >= closesAt),
      );
    } else if (last.reason === 4) {
      checks.equal(
        'refund.time',
        'a void is allowed only while the round is Open and before close',
        'true',
        String(at < closesAt),
      );
    } else if (last.reason === 6) {
      const timeout = await deps.chain.refundTimeout();
      checks.equal(
        'refund.time',
        `refundTimeout is callable only at closesAt + ${timeout}s`,
        'true',
        String(BigInt(at) >= BigInt(closesAt) + timeout),
      );
    } else {
      checks.fail('refund.reason', `unknown refund reason ${last.reason}`);
    }
  } catch (e) {
    checks.error('refund.chain', `the chain read failed: ${(e as Error).message}`);
  }
  const deadlinePassed =
    refundedAt !== null && now >= refundedAt * 1000 + REFUND_VERDICT_DEADLINE_MS;
  const v = await publish({
    env,
    key,
    subject: 'stakes_refund',
    roundId: snap.roundId,
    checks,
    now,
    deadlinePassed,
  });
  return v?.verdict ?? null;
}

/** Pages every proposal still without a verdict 30 minutes after it was proposed. */
async function pageMissingVerdicts(env: Env, now: number): Promise<number> {
  let paged = 0;
  for (const p of await unpagedProposals(env.DB)) {
    if (now < p.proposedAt * 1000 + MISSING_VERDICT_MS) continue;
    if (await queueMissingVerdictPage(env.DB, p, now)) {
      paged += 1;
      log('error', 'verdict_missing', {
        roundId: p.roundId,
        bundleHash: p.bundleHash,
        proposedAt: p.proposedAt,
      });
    }
    await markMissingPaged(env.DB, p.roundId, p.bundleHash, now);
  }
  return paged;
}

export async function tick(env: Env, deps: WatcherDeps, now: number): Promise<TickSummary> {
  const errors: string[] = [];
  const verdicts: TickSummary['verdicts'] = [];
  const snapshots = await snapshotRounds(env, deps, now, errors);

  let key: Hex | null = null;
  try {
    key = watcherKey(env.WATCHER_KEY);
  } catch (e) {
    errors.push((e as Error).message);
    log('error', 'watcher_key_missing', {});
  }

  if (key) {
    const sinceSec = Math.floor(now / 1000) - TRACK_WINDOW_SEC;
    for (const snap of await trackedRounds(env.DB, sinceSec, TRACK_LIMIT)) {
      try {
        const done = await verdictSubjects(env.DB, snap.roundId);
        if (!done.has('stakes_round')) {
          const v = await checkCreated(env, deps, key, snap, now);
          if (v) verdicts.push({ subject: 'stakes_round', roundId: snap.roundId, verdict: v });
        }
        await observeProposals(env, deps, snap, now);
        if (!done.has('stakes_proposal')) {
          // The round's latest proposal: a veto can be followed by another one.
          const seen = await proposalsFor(env.DB, snap.roundId);
          const proposal = seen[seen.length - 1];
          if (proposal) {
            const v = await checkProposal(env, deps, key, snap, proposal, now);
            if (v) verdicts.push({ subject: 'stakes_proposal', roundId: snap.roundId, verdict: v });
          }
        }
        if (!done.has('stakes_refund')) {
          const v = await checkRefund(env, deps, key, snap, now);
          if (v) verdicts.push({ subject: 'stakes_refund', roundId: snap.roundId, verdict: v });
        }
      } catch (e) {
        errors.push(`round ${snap.roundId}: ${(e as Error).message}`);
        log('error', 'round_check_failed', {
          roundId: snap.roundId,
          error: (e as Error).message.slice(0, 200),
        });
      }
    }
  }

  const paged = await pageMissingVerdicts(env, now);
  const flushed = await flushPages(env, now, deps.fetch);
  return {
    snapshots,
    verdicts,
    paged,
    delivered: flushed.delivered,
    failed: flushed.failed,
    errors,
  };
}
