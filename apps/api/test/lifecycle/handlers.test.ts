// The W4-D indexer handlers (src/lifecycle/handlers.ts): the guardian void path (spec "Round
// lifecycle": `RoundRefunded` reason 4 before close that the backend didn't start → Stakes voided,
// Free continues), ticketed `Entered` → RoundDO.ingestStakesEntry, and `Locked` / `Committed` →
// round_modes.lock_tx / commit_tx.
import { env, runInDurableObject } from 'cloudflare:test';
import { roundKey } from '@flocked/shared';
import { bytesToHex, keccak256, toHex, type Hex } from 'viem';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LockedRound } from '../../src/do/types.js';
import { foreignEntryHandler } from '../../src/indexer/entered.js';
import { handlers } from '../../src/indexer/handlers.js';
import { recordSentTx } from '../../src/indexer/sent.js';
import type { ChainEvent } from '../../src/indexer/types.js';
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
    expect(names('RoundRefunded')).toEqual(['alert-unsent-tx', 'stakes-void', 'stakes-refunded']);
    // W6-A: the Stakes outcome handlers.
    expect(names('OutcomeProposed')).toEqual(['alert-unsent-tx', 'stakes-proposal']);
    expect(names('ProposalVetoed')).toEqual(['alert-unsent-tx', 'stakes-veto']);
    expect(names('RoundFinalized')).toEqual(['alert-unsent-tx', 'stakes-finalized']);
    expect(names('ManifestAnchored')).toEqual(['alert-unsent-tx', 'anchor-confirmation']);
  });
});

describe('the guardian void: Stakes voided, Free continues', () => {
  it('writes a refund payouts row per ticketed Stakes entry, once (W6-D: every Stakes refund does)', async () => {
    queues = recordQueues();
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    setClock(T0);
    await r.stub.init(r.locked);
    const user = await createUser(0);
    const wallet = '0x00000000000000000000000000000000000000d1';
    const stake = Number(r.locked.config.stakes?.stake);
    await env.DB.prepare(
      `INSERT INTO entries (id, round_id, mode, user_id, wallet, person_tag, stake, commitment,
         tx_hash, block_number, log_index, created_at)
       VALUES ('01J00000000000000000000VD1', ?1, 'stakes', ?2, ?3, ?4, ?5, ?6, ?7, 10, 0, ?8)`,
    )
      .bind(
        r.locked.roundId,
        user,
        wallet,
        keccak256(toHex('person-void')),
        stake,
        keccak256(toHex('ct-void')),
        keccak256(toHex('tx-void')),
        T0,
      )
      .run();
    const evt = chainEvent('escrow', 'RoundRefunded', { roundId: r.chainRoundId, reason: '4' });
    const refunds = () =>
      env.DB.prepare(
        "SELECT user_id, wallet, kind, amount, claimed_at FROM payouts WHERE round_id = ?1 AND mode = 'stakes'",
      )
        .bind(r.locked.roundId)
        .all()
        .then((x) => x.results);
    await commitStatements(await stakesVoidHandler(evt, env, ctx));
    const first = await refunds();
    expect(first).toEqual([
      { user_id: user, wallet, kind: 'refund', amount: stake, claimed_at: null },
    ]);
    // A re-dispatch (a new revision) writes nothing more.
    await commitStatements(await stakesVoidHandler({ ...evt, revision: 2 }, env, ctx));
    expect(await refunds()).toEqual(first);
  });

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
    // The admin void the RoundDO is pushing (its voidRound sits unmined on the fake chain).
    fake.automine = false;
    expect((await r.stub.requestVoid()).accepted).toBe(true);
    const evt = chainEvent('escrow', 'RoundRefunded', { roundId: r.chainRoundId, reason: '4' });
    await recordSentTx(env, {
      chainId: evt.chainId,
      txHash: evt.txHash,
      kind: 'voidRound',
      roundKey: null,
    });
    await commitStatements(await stakesVoidHandler(evt, env, ctx));
    expect((await modeRow(r.locked.roundId, 'stakes'))?.status).toBe('voided');
    // The RoundDO applies an admin void to every mode itself (its own alarm may already have, now
    // that D1 has Stakes voided); the handler doesn't tell it a mode result.
    const meta = (await readMeta(r.stub)) as { results?: Record<string, unknown> } | undefined;
    expect(meta?.results?.stakes).toBeUndefined();
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

  it('a void or an anchor write re-mined in another block is not a removal for its handler', async () => {
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    const key = roundKey(r.locked.roundId, 'free');
    await env.DB.prepare(
      "UPDATE round_modes SET lock_tx = ?2 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(r.locked.roundId, `0x${'4c'.repeat(32)}`)
      .run();
    const captured = captureAlerts();
    // The indexer has mirrored both again in their new block before it dispatches the removals.
    const mirror = (evt: ChainEvent) =>
      env.DB.prepare(
        `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash,
           log_index, event, args_json, revision, created_at, updated_at)
         VALUES (?1, ?2, 201, ?3, 1, ?4, ?5, ?6, ?7, 2, 0, 0)`,
      )
        .bind(
          evt.chainId,
          evt.contract,
          `0x${'cd'.repeat(32)}`,
          evt.txHash,
          evt.logIndex,
          evt.event,
          JSON.stringify(evt.args),
        )
        .run();
    const voided = chainEvent('escrow', 'RoundRefunded', { roundId: r.chainRoundId, reason: '4' });
    const locked = chainEvent(
      'anchor',
      'Locked',
      { roundKey: key, closesAt: String(r.locked.closesAt / 1000) },
      { txHash: `0x${'4c'.repeat(32)}` },
    );
    await mirror(voided);
    await mirror(locked);
    await commitStatements(await stakesVoidHandler({ ...voided, removed: true }, env, ctx));
    await commitStatements(await anchorConfirmationHandler({ ...locked, removed: true }, env, ctx));
    captured.restore();
    expect(captured.alerts).toEqual([]);
    expect(await modeRow(r.locked.roundId, 'free')).toMatchObject({
      lock_tx: `0x${'4c'.repeat(32)}`,
    });
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

  it('W6-A: stores the entry with its ciphertext, keeps a re-added log’s new block, and un-counts a removed one', async () => {
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    setClock(T0);
    await r.stub.init(r.locked);
    const user = await createUser(0);
    const player = '0x00000000000000000000000000000000000000c1' as Hex;
    const personTag = keccak256(toHex('person-w6a'));
    const ticketHash = keccak256(toHex('ticket-w6a'));
    await env.DB.prepare(
      'INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)',
    )
      .bind(ticketHash, r.locked.roundId, personTag, user, player)
      .run();
    const stake = String(r.locked.config.stakes?.stake);
    const ciphertext: Hex = `0x${'ab'.repeat(80)}`;
    const evt = chainEvent(
      'escrow',
      'Entered',
      { roundId: r.chainRoundId, player, personTag, ticketHash, ciphertext },
      { blockNumber: 200 },
    );
    const stored = () =>
      env.DB.prepare(
        'SELECT user_id, wallet, ciphertext, commitment, block_number FROM entries WHERE tx_hash = ?1',
      )
        .bind(evt.txHash)
        .first<{
          user_id: string;
          wallet: string;
          ciphertext: ArrayBuffer;
          commitment: string;
          block_number: number;
        }>();
    const doBlocks = () =>
      runInDurableObject(r.stub, (_o, state) =>
        state.storage.sql
          .exec<{ block_number: number }>('SELECT block_number FROM stakes_entries')
          .toArray()
          .map((x) => x.block_number),
      );
    const counts = async () => (await r.stub.getState()).modes.stakes;

    const usedTx = () =>
      env.DB.prepare('SELECT used_tx FROM stakes_tickets WHERE ticket_hash = ?1')
        .bind(ticketHash)
        .first<{ used_tx: string | null }>()
        .then((x) => x?.used_tx);
    expect(await usedTx()).toBeNull();

    await commitStatements(await stakesIngestHandler(evt, env, ctx));
    const row = await stored();
    expect(row).toMatchObject({ user_id: user, wallet: player, commitment: keccak256(ciphertext) });
    // W6-D: the ticket is marked used, which the daily cap and the one-ticket rule read (W6-B).
    expect(await usedTx()).toBe(evt.txHash);
    expect(bytesToHex(new Uint8Array(row?.ciphertext ?? new ArrayBuffer(0)))).toBe(ciphertext);
    expect(await counts()).toMatchObject({ entrantCount: 1, pool: stake });

    // A reorg: the log leaves the chain (dispatched first), then comes back in another block.
    await commitStatements(
      await stakesIngestHandler({ ...evt, removed: true, revision: 2 }, env, ctx),
    );
    expect(await stored()).toBeNull();
    expect(await usedTx()).toBeNull();
    expect(await counts()).toMatchObject({ entrantCount: 0, pool: '0' });
    const moved = { ...evt, blockNumber: 205, revision: 3 };
    await commitStatements(await stakesIngestHandler(moved, env, ctx));
    expect((await stored())?.block_number).toBe(205);
    expect(await usedTx()).toBe(evt.txHash);
    expect(await counts()).toMatchObject({ entrantCount: 1, pool: stake });
    expect(await doBlocks()).toEqual([205]);

    // An addition at a slot already stored keeps the new block fields (in D1 and the RoundDO).
    await commitStatements(await stakesIngestHandler({ ...moved, blockNumber: 207 }, env, ctx));
    expect((await stored())?.block_number).toBe(207);
    expect(await doBlocks()).toEqual([207]);
    expect(await counts()).toMatchObject({ entrantCount: 1, pool: stake });
  });

  it('an entry the RoundDO refuses for good (another chain round) alerts and returns (V3)', async () => {
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    setClock(T0);
    await r.stub.init(r.locked);
    // D1 maps another escrow round to this round than the RoundDO was given: a permanent mismatch.
    const other = String(BigInt(r.chainRoundId) + 1000n);
    await env.DB.prepare(
      "UPDATE round_modes SET chain_round_id = ?2 WHERE round_id = ?1 AND mode = 'stakes'",
    )
      .bind(r.locked.roundId, other)
      .run();
    const user = await createUser(0);
    const player = '0x00000000000000000000000000000000000000b1' as Hex;
    const personTag = keccak256(toHex('person-v3'));
    const ticketHash = keccak256(toHex('ticket-v3'));
    await env.DB.prepare(
      'INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)',
    )
      .bind(ticketHash, r.locked.roundId, personTag, user, player)
      .run();
    const captured = captureAlerts();
    const evt = chainEvent('escrow', 'Entered', {
      roundId: other,
      player,
      personTag,
      ticketHash,
      ciphertext: '0x0102',
    });
    // Rethrown, it would stop dispatch at this row for good. The entry is still stored in D1 (W6-A):
    // the RoundDO's counters are a display value, D1 the settlement's input. W6-D: the second
    // statement marks the ticket used.
    const stmts = await stakesIngestHandler(evt, env, ctx);
    expect(stmts).toHaveLength(2);
    captured.restore();
    expect(
      captured.alerts.filter((a) => a.roundId === r.locked.roundId && a.code === 'ALERT_DO_ERROR'),
    ).toMatchObject([{ step: 'ingest_stakes_entry', txHash: evt.txHash }]);
    expect((await r.stub.getState()).modes.stakes).toMatchObject({ entrantCount: 0 });
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

describe('W6-F1 R11: a removed entry takes its refund payout with it', () => {
  it('an Entered removal after a void deletes that entry’s refund row only; a foreign entry never had one', async () => {
    const fake = fakeChainAt(T0);
    const r = await stakesRound(fake);
    setClock(T0);
    await r.stub.init(r.locked);
    const entered = async (tag: string, ticketed: boolean) => {
      const player = keccak256(toHex(`wallet-${tag}`)).slice(0, 42) as Hex;
      const personTag = keccak256(toHex(`person-${tag}`));
      const ticketHash = keccak256(toHex(`ticket-${tag}`));
      const user = ticketed ? await createUser(Number(tag.length)) : null;
      if (user) {
        await env.DB.prepare(
          'INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)',
        )
          .bind(ticketHash, r.locked.roundId, personTag, user, player)
          .run();
      }
      const evt = chainEvent('escrow', 'Entered', {
        roundId: r.chainRoundId,
        player,
        personTag,
        ticketHash,
        ciphertext: '0x0102',
      });
      const captured = captureAlerts();
      await commitStatements(await foreignEntryHandler(evt, env));
      await commitStatements(await stakesIngestHandler(evt, env, ctx));
      captured.restore();
      return { evt, user, player };
    };
    const a = await entered('a', true);
    const b = await entered('bb', true);
    const f = await entered('ccc', false);
    const refunds = () =>
      env.DB.prepare(
        "SELECT user_id, wallet FROM payouts WHERE round_id = ?1 AND mode = 'stakes' AND kind = 'refund' ORDER BY wallet",
      )
        .bind(r.locked.roundId)
        .all<{ user_id: string; wallet: string }>()
        .then((x) => x.results);

    // A guardian void refunds every ticketed entry (the foreign one has no account, so no row).
    const captured = captureAlerts();
    await commitStatements(
      await stakesVoidHandler(
        chainEvent('escrow', 'RoundRefunded', { roundId: r.chainRoundId, reason: '4' }),
        env,
        ctx,
      ),
    );
    captured.restore();
    const both = [a, b]
      .map((x) => ({ user_id: x.user as string, wallet: x.player }))
      .sort((p, q) => p.wallet.localeCompare(q.wallet));
    expect(await refunds()).toEqual(both);

    // a's Entered leaves the chain (and is not re-mined): its entry and its refund go.
    await commitStatements(
      await stakesIngestHandler({ ...a.evt, removed: true, revision: 2 }, env, ctx),
    );
    expect(await refunds()).toEqual([{ user_id: b.user as string, wallet: b.player }]);
    // The foreign entry's removal deletes its entry; there was never a payout to delete.
    await commitStatements(
      await foreignEntryHandler({ ...f.evt, removed: true, revision: 2 }, env),
    );
    expect(await refunds()).toEqual([{ user_id: b.user as string, wallet: b.player }]);
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM entries WHERE round_id = ?1 AND mode = 'stakes'",
    )
      .bind(r.locked.roundId)
      .first<{ n: number }>();
    expect(left?.n).toBe(1);
  });
});
