// The watcher's D1 (migrations/0001_watcher.sql). Snapshots, proposals, verdicts and pages are all
// write-once or append-only: a verdict is evidence, so nothing here ever rewrites one.
import { PublishedConfigSchema, type PublishedConfig } from './api.js';
import { VerdictSchema, type Verdict, type VerdictSubject, type VerdictValue } from './verdict.js';

export interface RoundSnapshot {
  roundId: string;
  gameDay: string;
  kind: 'daily' | 'room';
  roomId: string | null;
  /** Unix seconds. */
  opensAt: number;
  /** Unix seconds. */
  closesAt: number;
  beaconRound: number;
  beaconDelay: number;
  /** Decimal string; null when the round has no Stakes mode. */
  chainRoundId: string | null;
  isHouse: boolean;
  /** The published config as it was at lock. */
  config: PublishedConfig;
  /** Epoch ms when this watcher first saw it. */
  snapshotAt: number;
}

export interface ProposalRow {
  roundId: string;
  chainRoundId: string;
  bundleHash: string;
  txHash: string;
  blockNumber: number;
  /** Unix seconds: the proposal block's timestamp. */
  proposedAt: number;
  seenAt: number;
  missingPagedAt: number | null;
}

export interface PageRow {
  id: string;
  kind: string;
  body: string;
  attempts: number;
}

interface SnapshotRecord {
  round_id: string;
  game_day: string;
  kind: string;
  room_id: string | null;
  opens_at: number;
  closes_at: number;
  beacon_round: number;
  beacon_delay: number;
  chain_round_id: string | null;
  is_house: number;
  config_json: string;
  snapshot_at: number;
}

function toSnapshot(r: SnapshotRecord): RoundSnapshot {
  return {
    roundId: r.round_id,
    gameDay: r.game_day,
    kind: r.kind === 'room' ? 'room' : 'daily',
    roomId: r.room_id,
    opensAt: r.opens_at,
    closesAt: r.closes_at,
    beaconRound: r.beacon_round,
    beaconDelay: r.beacon_delay,
    chainRoundId: r.chain_round_id,
    isHouse: r.is_house === 1,
    config: PublishedConfigSchema.parse(JSON.parse(r.config_json)),
    snapshotAt: r.snapshot_at,
  };
}

/** Writes a snapshot once. Returns false when this round was already snapshotted. */
export async function putSnapshot(db: D1Database, s: RoundSnapshot): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO round_snapshots
         (round_id, game_day, kind, room_id, opens_at, closes_at, beacon_round, beacon_delay,
          chain_round_id, is_house, config_json, snapshot_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      s.roundId,
      s.gameDay,
      s.kind,
      s.roomId,
      s.opensAt,
      s.closesAt,
      s.beaconRound,
      s.beaconDelay,
      s.chainRoundId,
      s.isHouse ? 1 : 0,
      JSON.stringify(s.config),
      s.snapshotAt,
    )
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function getSnapshot(db: D1Database, roundId: string): Promise<RoundSnapshot | null> {
  const row = await db
    .prepare('SELECT * FROM round_snapshots WHERE round_id = ?1')
    .bind(roundId)
    .first<SnapshotRecord>();
  return row ? toSnapshot(row) : null;
}

/**
 * Snapshotted Stakes rounds that close at or after `sinceSec`, newest first: an open round's
 * `RoundCreated` check is the time-critical one, because a mismatch has to reach the guardian
 * before close.
 */
export async function trackedRounds(
  db: D1Database,
  sinceSec: number,
  limit: number,
): Promise<RoundSnapshot[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM round_snapshots WHERE chain_round_id IS NOT NULL AND closes_at >= ?1
       ORDER BY closes_at DESC LIMIT ?2`,
    )
    .bind(sinceSec, limit)
    .all<SnapshotRecord>();
  return results.map(toSnapshot);
}

interface VerdictRecord {
  subject: string;
  round_id: string;
  mode: string;
  verdict: string;
  reasons_json: string;
  checked_at: number;
  signature: string;
}

function toVerdict(r: VerdictRecord): Verdict {
  return VerdictSchema.parse({
    subject: r.subject,
    roundId: r.round_id,
    mode: r.mode,
    verdict: r.verdict,
    reasons: JSON.parse(r.reasons_json) as string[],
    checkedAt: r.checked_at,
    signature: r.signature,
  });
}

/** Stores a verdict once. Returns false when one was already published for this subject. */
export async function putVerdict(db: D1Database, v: Verdict): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO verdicts
         (subject, round_id, mode, verdict, reasons_json, checked_at, signature)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      v.subject,
      v.roundId,
      v.mode,
      v.verdict,
      JSON.stringify(v.reasons),
      v.checkedAt,
      v.signature,
    )
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function getVerdict(
  db: D1Database,
  subject: string,
  roundId: string,
): Promise<Verdict | null> {
  const row = await db
    .prepare('SELECT * FROM verdicts WHERE subject = ?1 AND round_id = ?2')
    .bind(subject, roundId)
    .first<VerdictRecord>();
  return row ? toVerdict(row) : null;
}

/** The subjects that already have a verdict for `roundId`. */
export async function verdictSubjects(db: D1Database, roundId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare('SELECT subject FROM verdicts WHERE round_id = ?1')
    .bind(roundId)
    .all<{ subject: string }>();
  return new Set(results.map((r) => r.subject));
}

/** Counts the verdicts of one value, for the tick's log line. */
export async function countVerdicts(db: D1Database, value: VerdictValue): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM verdicts WHERE verdict = ?1')
    .bind(value)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

interface ProposalRecord {
  round_id: string;
  chain_round_id: string;
  bundle_hash: string;
  tx_hash: string;
  block_number: number;
  proposed_at: number;
  seen_at: number;
  missing_paged_at: number | null;
}

const toProposal = (r: ProposalRecord): ProposalRow => ({
  roundId: r.round_id,
  chainRoundId: r.chain_round_id,
  bundleHash: r.bundle_hash,
  txHash: r.tx_hash,
  blockNumber: r.block_number,
  proposedAt: r.proposed_at,
  seenAt: r.seen_at,
  missingPagedAt: r.missing_paged_at,
});

/** Records a proposal once, the first time this watcher sees its log. */
export async function putProposal(db: D1Database, p: Omit<ProposalRow, 'missingPagedAt'>) {
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO proposals
         (round_id, chain_round_id, bundle_hash, tx_hash, block_number, proposed_at, seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(p.roundId, p.chainRoundId, p.bundleHash, p.txHash, p.blockNumber, p.proposedAt, p.seenAt)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function proposalsFor(db: D1Database, roundId: string): Promise<ProposalRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM proposals WHERE round_id = ?1 ORDER BY block_number')
    .bind(roundId)
    .all<ProposalRecord>();
  return results.map(toProposal);
}

/**
 * Proposals no verdict covers and no missing-verdict page has named yet. A verdict covers a
 * proposal only when it was checked at or after the proposal was posted, so a round re-proposed
 * after a veto is uncovered again by its earlier verdict.
 */
export async function unpagedProposals(db: D1Database): Promise<ProposalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.* FROM proposals p
       WHERE p.missing_paged_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM verdicts v
                         WHERE v.round_id = p.round_id AND v.subject = 'stakes_proposal'
                           AND v.checked_at >= p.proposed_at * 1000)
       ORDER BY p.proposed_at`,
    )
    .all<ProposalRecord>();
  return results.map(toProposal);
}

export async function markMissingPaged(
  db: D1Database,
  roundId: string,
  bundleHash: string,
  at: number,
): Promise<void> {
  await db
    .prepare('UPDATE proposals SET missing_paged_at = ?3 WHERE round_id = ?1 AND bundle_hash = ?2')
    .bind(roundId, bundleHash, at)
    .run();
}

/** Queues a page once per dedupe key. Returns false when the key was already queued. */
export async function putPage(
  db: D1Database,
  id: string,
  kind: string,
  body: unknown,
  now: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      'INSERT OR IGNORE INTO pages (id, kind, body_json, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
    .bind(id, kind, JSON.stringify(body), now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function undeliveredPages(db: D1Database, limit: number): Promise<PageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, body_json, attempts FROM pages
       WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: string; kind: string; body_json: string; attempts: number }>();
  return results.map((r) => ({ id: r.id, kind: r.kind, body: r.body_json, attempts: r.attempts }));
}

export async function markPageDelivered(db: D1Database, id: string, at: number): Promise<void> {
  await db
    .prepare(
      'UPDATE pages SET delivered_at = ?2, attempts = attempts + 1, last_error = NULL WHERE id = ?1',
    )
    .bind(id, at)
    .run();
}

export async function markPageFailed(db: D1Database, id: string, error: string): Promise<void> {
  await db
    .prepare('UPDATE pages SET attempts = attempts + 1, last_error = ?2 WHERE id = ?1')
    .bind(id, error.slice(0, 500))
    .run();
}

export type { Verdict, VerdictSubject };

export interface RoundState {
  createdBlock: number | null;
  refundedAt: number | null;
}

export async function getRoundState(db: D1Database, roundId: string): Promise<RoundState> {
  const row = await db
    .prepare('SELECT created_block, refunded_at FROM round_state WHERE round_id = ?1')
    .bind(roundId)
    .first<{ created_block: number | null; refunded_at: number | null }>();
  return { createdBlock: row?.created_block ?? null, refundedAt: row?.refunded_at ?? null };
}

export async function setRoundState(
  db: D1Database,
  roundId: string,
  s: Partial<RoundState>,
): Promise<void> {
  const current = await getRoundState(db, roundId);
  const next = { ...current, ...s };
  await db
    .prepare(
      `INSERT INTO round_state (round_id, created_block, refunded_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (round_id) DO UPDATE SET created_block = ?2, refunded_at = ?3`,
    )
    .bind(roundId, next.createdBlock, next.refundedAt)
    .run();
}
