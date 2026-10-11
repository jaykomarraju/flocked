// ALERT-8 (an event whose transaction the backend didn't send) and the foreign-entry path (an `Entered`
// with no ticket: stored with no user, ALERT_FOREIGN_EVENT, settlement held), through the built-in
// handlers and the real dispatcher.
import { env } from 'cloudflare:test';
import { flockedAnchorAbi, flockedEscrowAbi } from '@flocked/abi';
import { keccak256, type Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexOnce } from '../../src/indexer/core.js';
import { dispatchPending } from '../../src/indexer/dispatch.js';
import { resolveEntered } from '../../src/indexer/entered.js';
import { HandlerRegistry, registerBuiltinHandlers } from '../../src/indexer/handlers.js';
import { settlementHold } from '../../src/indexer/holds.js';
import { CREATE2_FACTORY, OPEN_EVENTS, ROLE_EVENTS } from '../../src/indexer/policy.js';
import { recordSentTx } from '../../src/indexer/sent.js';
import { FIXTURE_CONFIG, seedFixture, type Fixture } from '../helpers/index.js';
import {
  anchorEvent,
  captureAlerts,
  escrowEvent,
  FakeChain,
  hash32,
  lockedLog,
  useDeployment,
} from './helpers.js';

let seed = 300;
let chain: FakeChain;
let dep: ReturnType<typeof useDeployment>;
let captured: ReturnType<typeof captureAlerts>;
let fixture: Fixture;
const registry = registerBuiltinHandlers(new HandlerRegistry());

const cycle = async () => {
  await indexOnce({
    db: env.DB,
    rpc: chain,
    chainId: dep.chainId,
    targets: dep.targets,
    nowMs: Date.now(),
  });
  return dispatchPending(env, registry, {
    chainId: dep.chainId,
    targets: dep.targets,
    rpc: chain,
    nowMs: Date.now(),
  });
};
const foreign = () => captured.alerts.filter((a) => a.code === 'ALERT_FOREIGN_EVENT');

beforeAll(async () => {
  fixture = await seedFixture(env.DB);
});
beforeEach(() => {
  captured = captureAlerts();
  chain = new FakeChain();
  dep = useDeployment(seed++);
});
afterEach(() => vi.restoreAllMocks());

describe('ALERT-8: events the backend did not send', () => {
  it('alerts on a role-only event whose transaction is not in sent_txs', async () => {
    const b = chain.mine([lockedLog(dep.anchor, 1)], { from: `0x${'66'.repeat(20)}` });
    await cycle();
    expect(foreign()).toHaveLength(1);
    expect(foreign()[0]).toMatchObject({
      kind: 'unsent_tx',
      eventName: 'Locked',
      contract: dep.anchor,
      contractKind: 'anchor',
      txHash: b.logs[0]!.transactionHash,
      from: `0x${'66'.repeat(20)}`,
      severity: 'page',
    });
    // A replay does not alert again.
    await env.DB.prepare('DELETE FROM indexer_state WHERE chain_id = ?1').bind(dep.chainId).run();
    await cycle();
    expect(foreign()).toHaveLength(1);
  });

  it('stays quiet for a transaction recorded with recordSentTx', async () => {
    const txHash = chain.newTxHash();
    await recordSentTx(env, { chainId: dep.chainId, txHash, kind: 'lock', roundKey: null });
    await recordSentTx(env, { chainId: dep.chainId, txHash, kind: 'lock', roundKey: null }); // idempotent
    chain.mine([{ ...lockedLog(dep.anchor, 1), txHash }]);
    const roundTx = chain.newTxHash();
    await recordSentTx(env, {
      chainId: dep.chainId,
      txHash: roundTx.toUpperCase().replace('0X', '0x') as Hex,
      kind: 'createRound',
      roundKey: hash32('rk'),
    });
    chain.mine([
      {
        ...escrowEvent(dep.escrow, 'RoleRevoked', {
          role: hash32('R'),
          account: `0x${'0a'.repeat(20)}`,
          sender: `0x${'0b'.repeat(20)}`,
        }),
        txHash: roundTx,
      },
    ]);
    await cycle();
    expect(foreign()).toEqual([]);
  });

  it('alerts on a guardian void and a veto, but not on player or permissionless events', async () => {
    const roundId = 42n;
    chain.mine([
      escrowEvent(dep.escrow, 'Claimed', {
        roundId,
        player: `0x${'11'.repeat(20)}`,
        kind: 0,
        amount: 10n,
      }),
      escrowEvent(dep.escrow, 'RefundClaimed', {
        roundId,
        player: `0x${'11'.repeat(20)}`,
        amount: 5n,
      }),
      escrowEvent(dep.escrow, 'Withdrawn', { account: `0x${'11'.repeat(20)}`, amount: 5n }),
      escrowEvent(dep.escrow, 'Credited', { account: `0x${'22'.repeat(20)}`, amount: 1n }),
      escrowEvent(dep.escrow, 'RoundFinalized', { roundId, status: 3 }),
      escrowEvent(dep.escrow, 'RoundRefunded', { roundId, reason: 1 }),
      escrowEvent(dep.escrow, 'RoundRefunded', { roundId, reason: 6 }),
    ]);
    await cycle();
    expect(foreign()).toEqual([]);

    chain.mine([
      escrowEvent(dep.escrow, 'RoundRefunded', { roundId, reason: 4 }),
      escrowEvent(dep.escrow, 'ProposalVetoed', { roundId, evidenceHash: hash32('evidence') }),
      escrowEvent(dep.escrow, 'Paused', { account: `0x${'33'.repeat(20)}` }),
    ]);
    await cycle();
    expect(foreign().map((a) => a.eventName)).toEqual([
      'RoundRefunded',
      'ProposalVetoed',
      'Paused',
    ]);
  });

  it('ignores constructor events (a deployment through the CREATE2 factory)', async () => {
    chain.mine(
      [
        escrowEvent(dep.escrow, 'RoleGranted', {
          role: hash32('GUARDIAN_ROLE'),
          account: `0x${'0a'.repeat(20)}`,
          sender: CREATE2_FACTORY,
        }),
        escrowEvent(dep.escrow, 'TicketSignerSet', {
          previous: `0x${'00'.repeat(20)}`,
          current: `0x${'0d'.repeat(20)}`,
        }),
      ],
      { to: CREATE2_FACTORY },
    );
    chain.mine(
      [anchorEvent(dep.anchor, 'ReceiptSignerSet', { signer: EOA_SIGNER, validFrom: 1n })],
      {
        to: null,
      },
    );
    await cycle();
    expect(foreign()).toEqual([]);
  });

  it('classifies every event of both ABIs exactly once', () => {
    const events = (abi: readonly { type: string; name?: string }[]) =>
      abi
        .filter((x) => x.type === 'event')
        .map((x) => x.name!)
        .sort();
    for (const [kind, abi] of [
      ['escrow', flockedEscrowAbi],
      ['anchor', flockedAnchorAbi],
    ] as const) {
      const listed = [...OPEN_EVENTS[kind], ...ROLE_EVENTS[kind]].sort();
      expect(listed).toEqual(events(abi));
    }
  });
});

const EOA_SIGNER: Hex = `0x${'0e'.repeat(20)}`;
const PLAYER: Hex = `0x${'11'.repeat(20)}`;
const PERSON_TAG = hash32('person-tag');

function enteredLog(chainRoundId: bigint, player: Hex, ciphertext: Hex = '0xdeadbeef') {
  return escrowEvent(dep.escrow, 'Entered', {
    roundId: chainRoundId,
    player,
    personTag: PERSON_TAG,
    ticketHash: hash32(`ticket-${player}`),
    ciphertext,
  });
}

async function addTicket(roundId: string, wallet: Hex, ticketHash: Hex) {
  await env.DB.prepare(
    `INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)`,
  )
    .bind(ticketHash, roundId, PERSON_TAG, fixture.ids.user, wallet)
    .run();
}

describe('foreign entries', () => {
  it('maps a ticketed Entered to its user and leaves it to Stakes ingestion', async () => {
    await addTicket(fixture.ids.round, PLAYER, hash32('ticket-a'));
    const b = chain.mine([enteredLog(1n, PLAYER)]);
    await cycle();
    expect(foreign()).toEqual([]);
    const m = await resolveEntered(env.DB, {
      chainId: dep.chainId,
      args: {
        roundId: '1',
        player: PLAYER,
        personTag: PERSON_TAG,
        ticketHash: hash32('t'),
        ciphertext: '0x00',
      },
    });
    expect(m).toMatchObject({
      roundId: fixture.ids.round,
      userId: fixture.ids.user,
      stake: FIXTURE_CONFIG.stakes?.stake,
    });
    const row = await env.DB.prepare('SELECT id FROM entries WHERE tx_hash = ?1')
      .bind(b.logs[0]!.transactionHash)
      .first();
    expect(row).toBeNull();
  });

  it('stores an Entered with no ticket as a foreign entry, alerts, and holds Stakes settlement', async () => {
    const wallet: Hex = `0x${'44'.repeat(20)}`; // the ticket above is for PLAYER, not this wallet
    const ciphertext = '0x0102030405' as Hex;
    const b = chain.mine([enteredLog(1n, wallet, ciphertext)]);
    const txHash = b.logs[0]!.transactionHash;
    await cycle();

    const alerts = foreign().filter((a) => a.kind === 'foreign_entry');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      chainRoundId: '1',
      roundId: fixture.ids.round,
      player: wallet,
      txHash,
      stored: true,
      settlementHeld: true,
    });

    const entry = await env.DB.prepare(
      `SELECT round_id, mode, user_id, foreign_entry, wallet, person_tag, stake, commitment,
              hex(ciphertext) AS ct, block_number, log_index, created_at
       FROM entries WHERE tx_hash = ?1`,
    )
      .bind(txHash)
      .first();
    expect(entry).toEqual({
      round_id: fixture.ids.round,
      mode: 'stakes',
      user_id: null,
      foreign_entry: 1,
      wallet,
      person_tag: PERSON_TAG,
      stake: Number(FIXTURE_CONFIG.stakes?.stake),
      commitment: keccak256(ciphertext),
      ct: '0102030405',
      block_number: b.number,
      log_index: 0,
      created_at: b.timestamp * 1000,
    });
    expect(await settlementHold(env.DB, fixture.ids.round, 'stakes')).toMatchObject({
      reason: 'foreign_entry',
      txHash,
    });
    expect(await settlementHold(env.DB, fixture.ids.round, 'free')).toBeNull();

    // Replay: no second row, no second alert.
    await env.DB.prepare('DELETE FROM indexer_state WHERE chain_id = ?1').bind(dep.chainId).run();
    await cycle();
    expect(foreign().filter((a) => a.kind === 'foreign_entry')).toHaveLength(1);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE tx_hash = ?1')
      .bind(txHash)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);

    // Reorged out: the entry goes, the hold stays for the guardian.
    chain.reorg(1);
    chain.mineEmpty(2);
    await cycle();
    expect(
      await env.DB.prepare('SELECT id FROM entries WHERE tx_hash = ?1').bind(txHash).first(),
    ).toBeNull();
    expect(await settlementHold(env.DB, fixture.ids.round, 'stakes')).not.toBeNull();
  });

  it('alerts on an Entered for a chain round the backend does not know, storing nothing', async () => {
    const b = chain.mine([enteredLog(999n, PLAYER)]);
    await cycle();
    expect(foreign().filter((a) => a.kind === 'foreign_entry')[0]).toMatchObject({
      chainRoundId: '999',
      roundId: null,
      stored: false,
      settlementHeld: false,
    });
    expect(
      await env.DB.prepare('SELECT id FROM entries WHERE tx_hash = ?1')
        .bind(b.logs[0]!.transactionHash)
        .first(),
    ).toBeNull();
  });
});
