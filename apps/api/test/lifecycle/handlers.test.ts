// The W4-D indexer handlers (src/lifecycle/handlers.ts): the guardian void path (spec "Round
// lifecycle": `RoundRefunded` reason 4 before close that the backend didn't start → Stakes voided,
// Free continues), ticketed `Entered` → RoundDO.ingestStakesEntry, and `Locked` / `Committed` →
// round_modes.lock_tx / commit_tx.
import { env } from 'cloudflare:test';
import { roundKey } from '@flocked/shared';
import { keccak256, toHex, type Hex } from 'viem';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LockedRound } from '../../src/do/types.js';
import { handlers } from '../../src/indexer/handlers.js';
import { recordSentTx } from '../../src/indexer/sent.js';
import {
  anchorConfirmationHandler,
  stakesIngestHandler,
  stakesVoidHandler,
} from '../../src/lifecycle/handlers.js';
import { captureAlerts } from '../indexer/helpers.js';
import {
  alarmAt,
  createRound,
  createUser,
  okValue,
  readMeta,
  sealedPick,
  setClock,
  useTestSigner,
} from '../round-do/helpers.js';
import {
  chainEvent,
  commitStatements,
  fakeChainAt,
  modeRow,
  recordQueues,
  stakesRound,
} from './helpers.js';

const ctx = { rpc: undefined as never };

beforeAll(() => {
  useTestSigner();
});

let queues: ReturnType<typeof recordQueues> | null = null;
afterEach(() => {
  queues?.restore();
  queues = null;
});

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

describe('registrations', () => {
  it('the default registry runs the lifecycle handlers after the built-in ones', () => {
    const names = (event: string) => handlers.for(event).map((h) => h.name);
    expect(names('Entered')).toEqual(['alert-unsent-tx', 'foreign-entry', 'stakes-ingest']);
    expect(names('Locked')).toEqual(['alert-unsent-tx', 'anchor-confirmation']);
    expect(names('Committed')).toEqual(['alert-unsent-tx', 'anchor-confirmation']);
    expect(names('RoundRefunded')).toEqual(['alert-unsent-tx', 'stakes-void']);
  });
});

describe('the guardian void: Stakes voided, Free continues', () => {
  it('a reason-4 RoundRefunded the backend did not send voids Stakes only', async () => {
    queues = recordQueues();
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    const scope = r.locked.roomId as string;
    setClock(T0);
    await r.stub.init(r.locked);

    const evt = chainEvent('escrow', 'RoundRefunded', { roundId: r.chainRoundId, reason: '4' });
    await commitStatements(await stakesVoidHandler(evt, env, ctx));

    expect(await modeRow(r.locked.roundId, 'stakes')).toMatchObject({
      status: 'voided',
      refund_reason: 4,
      final_at: evt.blockTimestampSec * 1000,
    });
    expect((await modeRow(r.locked.roundId, 'free'))?.status).toBe('pending');
    const state = await r.stub.getState();
    expect(state.modes.stakes?.status).toBe('voided');
    expect(state.modes.free?.status).toBe('pending');
    expect(state.voidRequested).toBe(false);

    // Free continues: entries are accepted, and the scheduler's next init (which leaves the voided
    // mode out) is not a conflict.
    const a = await createUser(100, scope);
    okValue(
      await r.stub.enterFree({
        roundId: r.locked.roundId,
        userId: a,
        body: { stake: '25', ciphertext: await sealedPick(r.locked) },
      }),
    );
    const next: LockedRound = { ...r.locked, modes: ['free'] };
    delete next.chainRoundId;
    await r.stub.init(next);

    // A replay of the event changes nothing.
    await commitStatements(await stakesVoidHandler(evt, env, ctx));
    expect((await modeRow(r.locked.roundId, 'stakes'))?.final_at).toBe(
      evt.blockTimestampSec * 1000,
    );

    // Close builds the Free root; settlement is enqueued for Free alone.
    await alarmAt(r.stub, r.locked.closesAt);
    expect((await readMeta(r.stub))?.freeClose?.entryCount).toBe(1);
    await alarmAt(r.stub, r.locked.beaconTimeSec * 1000);
    expect(queues.settled.map((m) => m.mode)).toEqual(['free']);
  });

  it('a reason-4 RoundRefunded from our own voidRound only records the Stakes void', async () => {
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    setClock(T0);
    await r.stub.init(r.locked);
    const evt = chainEvent('escrow', 'RoundRefunded', { roundId: r.chainRoundId, reason: '4' });
    await recordSentTx(env, {
      chainId: evt.chainId,
      txHash: evt.txHash,
      kind: 'voidRound',
      roundKey: null,
    });
    await commitStatements(await stakesVoidHandler(evt, env, ctx));
    expect((await modeRow(r.locked.roundId, 'stakes'))?.status).toBe('voided');
    // The RoundDO applies an admin void to every mode itself; it is not told here.
    expect((await r.stub.getState()).modes.stakes?.status).toBe('pending');
  });

  it('other refund reasons and unknown chain rounds are not voids', async () => {
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    await commitStatements(
      await stakesVoidHandler(
        chainEvent('escrow', 'RoundRefunded', { roundId: r.chainRoundId, reason: '1' }),
        env,
        ctx,
      ),
    );
    await commitStatements(
      await stakesVoidHandler(
        chainEvent('escrow', 'RoundRefunded', { roundId: '999999', reason: '4' }),
        env,
        ctx,
      ),
    );
    expect((await modeRow(r.locked.roundId, 'stakes'))?.status).toBe('pending');
  });

  it('a reorged-out void alerts and changes nothing', async () => {
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    const captured = captureAlerts();
    const evt = chainEvent(
      'escrow',
      'RoundRefunded',
      { roundId: r.chainRoundId, reason: '4' },
      { removed: true },
    );
    await commitStatements(await stakesVoidHandler(evt, env, ctx));
    captured.restore();
    expect(captured.alerts.map((a) => [a.code, a.step])).toEqual([
      ['ALERT_DO_ERROR', 'void_reorged'],
    ]);
    expect((await modeRow(r.locked.roundId, 'stakes'))?.status).toBe('pending');
  });
});

describe('ticketed Entered → the RoundDO Stakes counters', () => {
  it('counts each event once and leaves foreign entries to the foreign-entry path', async () => {
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    setClock(T0);
    await r.stub.init(r.locked);
    const user = await createUser(0);
    const player = '0x00000000000000000000000000000000000000b1' as Hex;
    const personTag = keccak256(toHex('person-1'));
    const ticketHash = keccak256(toHex('ticket-1'));
    await env.DB.prepare(
      'INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)',
    )
      .bind(ticketHash, r.locked.roundId, personTag, user, player)
      .run();
    const stake = String(r.locked.config.stakes?.stake);
    const args = { roundId: r.chainRoundId, player, personTag, ticketHash, ciphertext: '0x0102' };

    const evt = chainEvent('escrow', 'Entered', args);
    await stakesIngestHandler(evt, env, ctx);
    await stakesIngestHandler(evt, env, ctx);
    expect((await r.stub.getState()).modes.stakes).toMatchObject({ entrantCount: 1, pool: stake });

    // A second entry (a different log) counts; an entry with no ticket does not.
    await stakesIngestHandler(chainEvent('escrow', 'Entered', args), env, ctx);
    await stakesIngestHandler(
      chainEvent('escrow', 'Entered', { ...args, personTag: keccak256(toHex('stranger')) }),
      env,
      ctx,
    );
    expect((await r.stub.getState()).modes.stakes).toMatchObject({
      entrantCount: 2,
      pool: String(BigInt(stake) * 2n),
    });

    // The ingest itself is idempotent by (txHash, logIndex).
    const again = await r.stub.ingestStakesEntry({
      roundId: r.locked.roundId,
      chainRoundId: r.chainRoundId,
      player,
      personTag,
      ticketHash,
      stake,
      commitment: keccak256('0x0102'),
      userId: user,
      txHash: evt.txHash,
      blockNumber: evt.blockNumber,
      logIndex: evt.logIndex,
      blockTimestampSec: evt.blockTimestampSec,
    });
    expect(again).toEqual({ counted: false, entrantCount: 2, pool: String(BigInt(stake) * 2n) });
  });
});

describe('Locked / Committed → round_modes lock_tx / commit_tx', () => {
  async function lockedEventRow(key: Hex, closesAtSec: number): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash, log_index,
         event, args_json, removed, revision, created_at, updated_at)
       VALUES (31337, ?1, 1, ?2, 1, ?3, 0, 'Locked', ?4, 0, 1, 0, 0)`,
    )
      .bind(
        '0xa0c0000000000000000000000000000000000a01',
        `0x${'cd'.repeat(32)}`,
        keccak256(toHex(`lock-${key}`)),
        JSON.stringify({ roundKey: key, closesAt: String(closesAtSec) }),
      )
      .run();
  }

  it('records both confirmations, alerts on a root mismatch and clears a reorged write', async () => {
    const r = await createRound();
    const id = r.locked.roundId;
    const key = roundKey(id, 'free');
    const closesAtSec = r.locked.closesAt / 1000;
    const root = keccak256(toHex('root'));
    await env.DB.prepare(
      "UPDATE round_modes SET commitment_root = ?2 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(id, root)
      .run();

    const locked = chainEvent('anchor', 'Locked', { roundKey: key, closesAt: String(closesAtSec) });
    await commitStatements(await anchorConfirmationHandler(locked, env, ctx));
    expect((await modeRow(id, 'free'))?.lock_tx).toBe(locked.txHash);

    await lockedEventRow(key, closesAtSec);
    const captured = captureAlerts();
    const committed = chainEvent('anchor', 'Committed', { roundKey: key, commitmentRoot: root });
    await commitStatements(await anchorConfirmationHandler(committed, env, ctx));
    expect((await modeRow(id, 'free'))?.commit_tx).toBe(committed.txHash);
    expect(captured.alerts).toEqual([]);

    // A Committed whose root differs from ours alerts.
    const other = chainEvent('anchor', 'Committed', {
      roundKey: key,
      commitmentRoot: keccak256(toHex('other')),
    });
    await commitStatements(await anchorConfirmationHandler(other, env, ctx));
    captured.restore();
    expect(captured.alerts.map((a) => [a.code, a.step])).toEqual([
      ['ALERT_DO_ERROR', 'commitment_mismatch'],
    ]);
    expect((await modeRow(id, 'free'))?.commit_tx).toBe(committed.txHash);

    // The lock leaves the canonical chain: lock_tx is cleared, so the scheduler sends it again.
    await commitStatements(
      await anchorConfirmationHandler({ ...locked, removed: true, revision: 2 }, env, ctx),
    );
    expect((await modeRow(id, 'free'))?.lock_tx).toBeNull();
  });

  it('ignores keys that are not one of our Free rounds', async () => {
    const r = await createRound();
    const evt = chainEvent('anchor', 'Locked', {
      roundKey: keccak256(toHex('someone else')),
      closesAt: String(r.locked.closesAt / 1000),
    });
    expect(await anchorConfirmationHandler(evt, env, ctx)).toBeUndefined();
    expect((await modeRow(r.locked.roundId, 'free'))?.lock_tx).toBeNull();
  });
});
