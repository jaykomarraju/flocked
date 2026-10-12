// The Stakes entry set (spec "Sealed picks" › Stakes mode specifics; "Round lifecycle": from close,
// stream `Entered` logs into chunk files). SettlementDO drives it from close, one step per alarm:
//   1. the close block (src/chain/safe-head.ts), once the head is stamped at or after closesAt;
//   2. the round's `Entered` logs from its createRound block, LOG_WINDOW blocks per eth_getLogs, never
//      past the safe head, so everything streamed is final; each window's logs go to R2 files of at
//      most ENTERED_FILE_SIZE entries;
//   3. once the safe head has passed the close block (ALERT_SAFE_HEAD_LAG at beacon time + 60 s),
//      the rest up to the close block, then the reconciliation: the log count and stake sum must
//      equal FlockedEscrow's `entryCount` and `roundBalance` at the close block;
//   4. a mismatch alerts (ALERT_SETTLEMENT_FAILED) and reads everything again from the second
//      provider; a mismatch there too is final: nothing is posted, the round stays Open, and the
//      72-hour timeout is the backstop. A primary that can't serve `getRound` at the close block (no
//      archive state) is a provider failure, and the second provider reads everything again too
//      (W6-F1 R5).
// The files are working files (docs/bundle-format.md › Working files): deterministic, so a step that
// runs again rewrites them with the same bytes.
import type { Hex, PublicClient } from 'viem';
import {
  CloseBlockReorgedError,
  closeBlockFor,
  safeHeadPast,
  type CloseBlock,
} from '../../chain/safe-head.js';
import { deploymentOf, type ChainEnv } from '../../chain/client.js';
import type { Env } from '../../env.js';
import { raiseAlert } from '../../lib/alert.js';
import { log } from '../../lib/log.js';
import { workPrefix } from '../keys.js';
import { IntegrityError, type SettlementRound } from '../prepare.js';
import {
  enteredLogs,
  escrowOf,
  providerClient,
  readEscrowRound,
  type EnteredLog,
  type EscrowDeps,
  type EscrowRound,
  type Provider,
} from './escrow.js';

/** Entries per entry-set file. */
export const ENTERED_FILE_SIZE = 500;
/** Blocks per eth_getLogs call (a range a provider refuses is halved; src/settlement/stakes/escrow.ts). */
export const LOG_WINDOW = 2_000;
/** eth_getLogs windows per step, so one alarm stays well inside the subrequest budget. */
export const WINDOWS_PER_STEP = 20;
/** How often a waiting step looks again (three Base blocks). */
export const ENTRY_SET_POLL_MS = 6_000;
/** ALERT_SAFE_HEAD_LAG when the safe head isn't past the close block this long after beacon time. */
export const SAFE_HEAD_ALERT_AFTER_MS = 60_000;

/** One `Entered` event of the round, at its place in the entry order. */
export interface StreamedEntry extends EnteredLog {
  /** Position in (block, log index) order, from 0: the bundle's `seq`. */
  seq: number;
}

export interface EnteredFile {
  roundId: string;
  index: number;
  entries: StreamedEntry[];
}

export interface EntrySetState {
  provider: Provider;
  /** The createRound block: no entry can be earlier. */
  fromBlock: number | null;
  /** The next block to read. */
  cursor: number | null;
  closeBlock: CloseBlock | null;
  files: number;
  count: number;
  /** The count and stake sum matched the contract at the close block. */
  reconciled: boolean;
  safeHeadAlerted: boolean;
}

export function newEntrySet(): EntrySetState {
  return {
    provider: 'primary',
    fromBlock: null,
    cursor: null,
    closeBlock: null,
    files: 0,
    count: 0,
    reconciled: false,
    safeHeadAlerted: false,
  };
}

export type EntrySetStep =
  | { status: 'wait'; ms: number; detail: string }
  | { status: 'ready'; count: number; closeBlock: CloseBlock }
  /** Final: the second provider disagrees with the contract too. */
  | { status: 'mismatch'; detail: string };

export interface EntrySetContext {
  /** Game clock, epoch ms. */
  nowMs: number;
  beaconTimeSec: number;
  deps?: EscrowDeps;
}

export type EntrySetEnv = ChainEnv & Pick<Env, 'DB' | 'BUCKET' | 'ANALYTICS' | 'ENVIRONMENT'>;

export function enteredFileKey(roundId: string, index: number): string {
  return `${workPrefix(roundId, 'stakes')}entered-${String(index).padStart(4, '0')}.json`;
}

/** The streamed entries in seq order (the first `files` files of the round). */
export async function* streamedEntries(
  bucket: R2Bucket,
  roundId: string,
  files: number,
): AsyncGenerator<StreamedEntry> {
  for (let i = 0; i < files; i++) {
    const key = enteredFileKey(roundId, i);
    const obj = await bucket.get(key);
    if (!obj) throw new Error(`entry-set file ${key} is missing`);
    yield* (await obj.json<EnteredFile>()).entries;
  }
}

/** The createRound transaction's block, else the escrow's deploy block. */
async function startBlock(
  env: EntrySetEnv,
  client: PublicClient,
  round: SettlementRound,
): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT lock_tx FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'",
  )
    .bind(round.roundId)
    .first<{ lock_tx: string | null }>();
  if (row?.lock_tx) {
    const receipt = await client.getTransactionReceipt({ hash: row.lock_tx as Hex });
    return Number(receipt.blockNumber);
  }
  return Number(deploymentOf(env).deployBlock);
}

/** Moves the entry set one step further (see the header). Mutates `s`; the caller saves it. */
export async function advanceEntrySet(
  env: EntrySetEnv,
  round: SettlementRound,
  s: EntrySetState,
  ctx: EntrySetContext,
): Promise<EntrySetStep> {
  if (s.reconciled && s.closeBlock) {
    return { status: 'ready', count: s.count, closeBlock: s.closeBlock };
  }
  const chainRoundId = round.chainRoundId;
  const stake = round.config.stakes?.stake;
  if (chainRoundId === null || stake === undefined) {
    throw new IntegrityError('the Stakes mode has no chain round or no stake');
  }
  const client = providerClient(env, s.provider, ctx.deps);
  if (!client) throw new Error(`no RPC provider for ${s.provider}`);
  const escrow = escrowOf(env);
  const closesAtSec = Math.floor(round.closesAt / 1000);

  if (s.fromBlock === null || s.cursor === null) {
    s.fromBlock = await startBlock(env, client, round);
    s.cursor = s.fromBlock;
  }
  s.closeBlock ??= await closeBlockFor(client, closesAtSec);
  let past = false;
  if (s.closeBlock) {
    try {
      past = await safeHeadPast(client, s.closeBlock);
    } catch (err) {
      if (!(err instanceof CloseBlockReorgedError)) throw err;
      // Only unsafe blocks can change, and nothing past the safe head was streamed.
      log.warn('stakes_close_block_reorged', {
        roundId: round.roundId,
        block: s.closeBlock.number,
      });
      s.closeBlock = null;
      return { status: 'wait', ms: 0, detail: 'the close block was reorged' };
    }
  }

  const limit =
    past && s.closeBlock
      ? s.closeBlock.number
      : Number((await client.getBlock({ blockTag: 'safe' })).number);
  for (let w = 0; s.cursor <= limit && w < WINDOWS_PER_STEP; w++) {
    const to = Math.min(s.cursor + LOG_WINDOW - 1, limit);
    const logs = await enteredLogs(client, escrow, chainRoundId, s.cursor, to);
    for (let i = 0; i < logs.length; i += ENTERED_FILE_SIZE) {
      const entries = logs
        .slice(i, i + ENTERED_FILE_SIZE)
        .map((l, k): StreamedEntry => ({ seq: s.count + k, ...l }));
      const file: EnteredFile = { roundId: round.roundId, index: s.files, entries };
      await env.BUCKET.put(enteredFileKey(round.roundId, s.files), JSON.stringify(file), {
        httpMetadata: { contentType: 'application/json' },
      });
      s.files += 1;
      s.count += entries.length;
    }
    s.cursor = to + 1;
  }
  if (s.cursor <= limit) return { status: 'wait', ms: 0, detail: 'streaming' };

  if (!past || !s.closeBlock) {
    const lateAt = ctx.beaconTimeSec * 1000 + SAFE_HEAD_ALERT_AFTER_MS;
    if (!s.safeHeadAlerted && ctx.nowMs >= lateAt) {
      s.safeHeadAlerted = true;
      raiseAlert(env, 'ALERT_SAFE_HEAD_LAG', {
        roundId: round.roundId,
        mode: 'stakes',
        closeBlock: s.closeBlock?.number ?? null,
        safeHead: limit,
        beaconTime: ctx.beaconTimeSec,
      });
    }
    const ms = s.closeBlock
      ? ENTRY_SET_POLL_MS
      : Math.max(ENTRY_SET_POLL_MS, round.closesAt - ctx.nowMs);
    const detail = s.closeBlock ? 'the safe head is not past the close block' : 'before close';
    return { status: 'wait', ms, detail };
  }

  let onchain: EscrowRound;
  try {
    onchain = await readEscrowRound(client, escrow, chainRoundId, s.closeBlock.number);
  } catch (err) {
    // R5 (W6-F1): a provider without the close block's state (no archive node) fails this read on
    // every retry. A provider failure, not a verdict: the second provider reads everything again,
    // as after a mismatch (without the integrity alert). On the second provider it is retried.
    if (s.provider !== 'primary' || providerClient(env, 'fallback', ctx.deps) === null) throw err;
    log.warn('stakes_reconcile_read_failed', {
      roundId: round.roundId,
      provider: s.provider,
      closeBlock: s.closeBlock.number,
      error: err instanceof Error ? err.message : String(err),
    });
    toFallback(s);
    return {
      status: 'wait',
      ms: 0,
      detail:
        'primary: getRound at the close block failed; reading again from the fallback provider',
    };
  }
  const sum = BigInt(stake) * BigInt(s.count);
  if (
    onchain.entryCount === s.count &&
    onchain.roundBalance === sum &&
    onchain.stake === BigInt(stake)
  ) {
    s.reconciled = true;
    log.info('stakes_entry_set_reconciled', {
      roundId: round.roundId,
      provider: s.provider,
      entries: s.count,
      files: s.files,
      closeBlock: s.closeBlock.number,
    });
    return { status: 'ready', count: s.count, closeBlock: s.closeBlock };
  }
  const detail =
    `${s.provider}: ${s.count} Entered logs (stake ${sum}) at block ${s.closeBlock.number}, but ` +
    `entryCount ${onchain.entryCount}, roundBalance ${onchain.roundBalance}, stake ${onchain.stake}`;
  const fallback = s.provider === 'primary' && providerClient(env, 'fallback', ctx.deps) !== null;
  raiseAlert(env, 'ALERT_SETTLEMENT_FAILED', {
    roundId: round.roundId,
    mode: 'stakes',
    step: 'stakes_reconcile',
    provider: s.provider,
    logCount: s.count,
    logStake: sum.toString(),
    entryCount: onchain.entryCount,
    roundBalance: onchain.roundBalance.toString(),
    closeBlock: s.closeBlock.number,
    next: fallback ? 'fallback' : 'none',
  });
  if (fallback) {
    toFallback(s);
    return { status: 'wait', ms: 0, detail: `${detail}; reading again from the fallback provider` };
  }
  return { status: 'mismatch', detail };
}

/** Starts the entry set over on the second provider (everything is read again from it). */
function toFallback(s: EntrySetState): void {
  Object.assign(s, { ...newEntrySet(), provider: 'fallback', safeHeadAlerted: s.safeHeadAlerted });
}
