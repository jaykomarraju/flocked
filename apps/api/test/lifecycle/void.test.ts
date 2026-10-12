// SET-1b (rule 4) and the two-phase void (spec "Round lifecycle" › Void; "Settlement and payout math"
// › Refund rules): the RoundDO stops entries as soon as a void is requested; with a Stakes mode,
// `voidRound` must be mined in a block stamped before closesAt (FlockedEscrow refuses it after), and
// then every mode is voided with refund reason 4 and every Free stake comes back. A void that misses
// close is abandoned and every mode follows the normal close path.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { VOID_REFUSED_ALERT_AFTER } from '../../src/do/round-do.js';
import { recordSentTx } from '../../src/indexer/sent.js';
import { stakesVoidHandler } from '../../src/lifecycle/handlers.js';
import type { RpcResult, EnterFreeResponse } from '../../src/do/types.js';
import { VOID_RESOLVE_GRACE_MS } from '../../src/lifecycle/void.js';
import { captureAlerts } from '../indexer/helpers.js';
import {
  alarmAt,
  balance,
  createUser,
  errCode,
  ledgerRows,
  okValue,
  readMeta,
  sealedPick,
  setClock,
  useTestSigner,
  type TestRound,
} from '../round-do/helpers.js';
import {
  chainEvent,
  commitStatements,
  fakeChainAt,
  modeRow,
  recordQueues,
  roundStatus,
  stakesRound,
  voidRecord,
} from './helpers.js';

beforeAll(() => {
  useTestSigner();
});

let queues: ReturnType<typeof recordQueues> | null = null;
afterEach(() => {
  queues?.restore();
  queues = null;
});

async function enter(r: TestRound, userId: string, stake = '25', ciphertext?: string) {
  return r.stub.enterFree({
    roundId: r.locked.roundId,
    userId,
    body: { stake, ciphertext: ciphertext ?? (await sealedPick(r.locked)) },
  });
}

describe('SET-1b (rule 4): a void before close', () => {
  it('voids every mode with reason 4 once voidRound is mined before closesAt, refunding Free', async () => {
    queues = recordQueues();
    const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
    const fake = fakeChainAt(t0);
    const r = await stakesRound(fake);
    const scope = r.locked.roomId as string;
    setClock(t0);
    await r.stub.init(r.locked);
    expect((await r.stub.getState()).status).toBe('open');

    const a = await createUser(100, scope);
    const b = await createUser(100, scope);
    const ctA = await sealedPick(r.locked, 0);
    const first = okValue(await enter(r, a, '25', ctA));
    okValue(await enter(r, b, '40'));
    expect(await balance(a, scope)).toBe(75);

    // Phase 1: entries stop at once.
    const req = await r.stub.requestVoid();
    expect(req).toEqual({ accepted: true, stoppedAt: t0 });
    expect((await r.stub.getState()).voidRequested).toBe(true);
    const c = await createUser(100, scope);
    expect(errCode(await enter(r, c))).toBe('round_closed');
    // An identical retry of a committed entry still gets its receipt.
    const replay = okValue(await enter(r, a, '25', ctA));
    expect(replay.receipt).toEqual(first.receipt);
    // A repeat request answers the first one.
    expect(await r.stub.requestVoid()).toEqual({ accepted: true, stoppedAt: t0 });

    // Phase 2, from the alarm (requestVoid set it for now): voidRound is mined, chain time being
    // before closesAt.
    await alarmAt(r.stub, t0 + 1_000);
    expect(fake.escrowRounds.get(BigInt(r.chainRoundId))?.open).toBe(false);
    const v = await voidRecord(r.stub);
    expect(v).toMatchObject({ state: 'confirmed', applied: true });
    expect(v?.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    for (const mode of ['free', 'stakes'] as const) {
      const row = await modeRow(r.locked.roundId, mode);
      expect(row).toMatchObject({ status: 'voided', refund_reason: 4, commitment_root: null });
      expect(row?.final_at).toBeGreaterThanOrEqual(t0);
    }
    expect(await roundStatus(r.locked.roundId)).toBe('closed');
    // Every Free stake came back, once.
    expect(await balance(a, scope)).toBe(100);
    expect(await balance(b, scope)).toBe(100);
    expect((await ledgerRows(a)).filter((x) => x.reason === 'void_refund')).toEqual([
      { reason: 'void_refund', delta: 25 },
    ]);
    const state = await r.stub.getState();
    expect(state.status).toBe('closed');
    expect(state.modes.free?.status).toBe('voided');
    expect(state.modes.stakes?.status).toBe('voided');

    // Nothing else runs: no commitment, no settlement, no rule 8, even long after the beacon.
    await alarmAt(r.stub, r.locked.beaconTimeSec * 1000 + 25 * 3_600_000);
    expect(queues.settled).toEqual([]);
    expect((await readMeta(r.stub))?.freeClose).toBeNull();
    expect(await balance(a, scope)).toBe(100);
  });

  it('a Free-only round confirms the void at once (nothing onchain)', async () => {
    queues = recordQueues();
    const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
    const fake = fakeChainAt(t0);
    const r = await stakesRound(fake, { modes: ['free'] });
    setClock(t0);
    await r.stub.init(r.locked);
    const a = await createUser(100, r.locked.roomId as string);
    okValue(await enter(r, a));
    expect((await r.stub.requestVoid()).accepted).toBe(true);
    await alarmAt(r.stub, t0);
    expect(await voidRecord(r.stub)).toMatchObject({ state: 'confirmed', applied: true });
    expect(fake.sent).toHaveLength(0);
    expect(await modeRow(r.locked.roundId, 'free')).toMatchObject({
      status: 'voided',
      refund_reason: 4,
    });
    expect(await balance(a, r.locked.roomId as string)).toBe(100);
  });

  it('is refused once closesAt has passed', async () => {
    queues = recordQueues();
    const fake = fakeChainAt(Date.UTC(2026, 9, 8, 12, 0, 0));
    const r = await stakesRound(fake);
    setClock(r.locked.closesAt - 60_000);
    await r.stub.init(r.locked);
    setClock(r.locked.closesAt);
    expect(await r.stub.requestVoid()).toEqual({ accepted: false, stoppedAt: r.locked.closesAt });
    expect((await r.stub.getState()).voidRequested).toBe(false);
  });
});

describe('a void that misses close is abandoned', () => {
  it('voidRound unmined until the chain passes closesAt: the round closes normally', async () => {
    queues = recordQueues();
    const captured = captureAlerts();
    const closesAt = Date.UTC(2026, 9, 9, 1, 0, 0);
    const fake = fakeChainAt(closesAt - 30_000);
    const r = await stakesRound(fake);
    expect(r.locked.closesAt).toBe(closesAt);
    const scope = r.locked.roomId as string;
    setClock(closesAt - 30_000);
    await r.stub.init(r.locked);
    const a = await createUser(100, scope);
    const entered = okValue(await enter(r, a));

    // The void is requested 30 s before close, but its transaction sits unmined.
    fake.automine = false;
    expect((await r.stub.requestVoid()).accepted).toBe(true);
    await alarmAt(r.stub, closesAt - 29_000);
    expect(fake.pool.size).toBe(1);
    expect(await voidRecord(r.stub)).toMatchObject({ state: 'requested' });
    // Entries stay stopped meanwhile.
    expect(errCode(await enter(r, await createUser(100, scope)))).toBe('round_closed');

    // At close the chain head is still before closesAt: close waits, without an alert.
    fake.time = Math.floor(closesAt / 1000) - 1;
    await alarmAt(r.stub, closesAt);
    expect((await readMeta(r.stub))?.done).not.toContain('close');
    expect(await voidRecord(r.stub)).toMatchObject({ state: 'requested' });

    // The chain moves past closesAt; the pending voidRound is mined there and reverts.
    fake.time = Math.floor(closesAt / 1000) + 2;
    fake.mine();
    await alarmAt(r.stub, closesAt + 10_000);
    expect(await voidRecord(r.stub)).toMatchObject({ state: 'abandoned' });
    expect(fake.escrowRounds.get(BigInt(r.chainRoundId))?.open).toBe(true);

    // The normal close path: Free root over the entries made before the request, modes pending.
    const meta = await readMeta(r.stub);
    expect(meta?.done).toContain('close');
    expect(meta?.freeClose?.entryCount).toBe(1);
    expect(meta?.freeClose?.root).toMatch(/^0x[0-9a-f]{64}$/);
    for (const mode of ['free', 'stakes'] as const) {
      expect((await modeRow(r.locked.roundId, mode))?.status).toBe('pending');
    }
    expect(await roundStatus(r.locked.roundId)).toBe('closed');
    expect(await balance(a, scope)).toBe(75);
    const state = await r.stub.getState();
    expect(state.voidRequested).toBe(false);
    expect(entered.entry.stake).toBe('25');

    // Both modes are settled as usual at beacon time.
    await alarmAt(r.stub, r.locked.beaconTimeSec * 1000);
    expect(queues.settled.map((m) => m.mode).sort()).toEqual(['free', 'stakes']);
    // No RoundDO alert (the AnchorDO alerts on its own: it has no ANCHOR_KEY in this test).
    captured.restore();
    expect(captured.alerts.filter((x) => x.roundId === r.locked.roundId)).toEqual([]);
  });

  it('gives up 20 s after closesAt even if the chain head never passes it (anvil mines no empty blocks)', async () => {
    queues = recordQueues();
    const closesAt = Date.UTC(2026, 9, 9, 1, 0, 0);
    const fake = fakeChainAt(closesAt - 10_000);
    const r = await stakesRound(fake);
    setClock(closesAt - 10_000);
    await r.stub.init(r.locked);
    fake.automine = false;
    await r.stub.requestVoid();
    await alarmAt(r.stub, closesAt - 9_000);
    // The head stays stamped before closesAt.
    fake.time = Math.floor(closesAt / 1000) - 5;
    await alarmAt(r.stub, closesAt + 19_000);
    expect((await voidRecord(r.stub))?.state).toBe('requested');
    // Close retries every 3 s; the first retry past the grace gives up.
    await alarmAt(r.stub, closesAt + VOID_RESOLVE_GRACE_MS + 3_000);
    expect((await voidRecord(r.stub))?.state).toBe('abandoned');
    expect((await readMeta(r.stub))?.freeClose?.anchor).toBe('none');
  });

  it('a requestVoid answers false once the void was abandoned', async () => {
    queues = recordQueues();
    const closesAt = Date.UTC(2026, 9, 9, 1, 0, 0);
    const fake = fakeChainAt(closesAt - 10_000);
    const r = await stakesRound(fake);
    setClock(closesAt - 10_000);
    await r.stub.init(r.locked);
    // FlockedEscrow says the round is no longer Open (an unindexed guardian void would do this).
    fake.escrowRounds.get(BigInt(r.chainRoundId))!.open = false;
    expect((await r.stub.requestVoid()).accepted).toBe(true);
    await alarmAt(r.stub, closesAt - 9_000);
    expect((await voidRecord(r.stub))?.state).toBe('requested');
    fake.time = Math.floor(closesAt / 1000);
    await alarmAt(r.stub, closesAt);
    expect((await voidRecord(r.stub))?.state).toBe('abandoned');
    const again: { accepted: boolean } = await r.stub.requestVoid();
    expect(again.accepted).toBe(false);
  });
});

describe('the void and Free entries in flight', () => {
  it('an entry committed before the void is refunded; one after the seal is refused', async () => {
    queues = recordQueues();
    const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
    const fake = fakeChainAt(t0);
    const r = await stakesRound(fake, { modes: ['free'] });
    const scope = r.locked.roomId as string;
    setClock(t0);
    await r.stub.init(r.locked);
    const users = await Promise.all([1, 2, 3].map(() => createUser(100, scope)));
    const results: RpcResult<EnterFreeResponse>[] = await Promise.all(
      users.map((u) => enter(r, u)),
    );
    await r.stub.requestVoid();
    await alarmAt(r.stub, t0);
    for (const [i, res] of results.entries()) {
      expect(res.ok).toBe(true);
      expect(await balance(users[i] as string, scope)).toBe(100);
    }
    const { results: ledger } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM points_ledger WHERE reason = 'void_refund' AND ref_id = ?1",
    )
      .bind(r.locked.roundId)
      .all<{ n: number }>();
    expect(ledger[0]?.n).toBe(3);
  });
});

describe('W4-F1: a void is abandoned at close only on proof (V1)', () => {
  it('a push that throws at close is never proof: close waits, even with the head past closesAt', async () => {
    queues = recordQueues();
    const closesAt = Date.UTC(2026, 9, 10, 1, 0, 0);
    const fake = fakeChainAt(closesAt - 10_000);
    const r = await stakesRound(fake, { opensAt: closesAt - 24 * 3_600_000 });
    setClock(closesAt - 10_000);
    await r.stub.init(r.locked);
    fake.automine = false;
    await r.stub.requestVoid();
    await alarmAt(r.stub, closesAt - 9_000);
    expect(fake.pool.size).toBe(1);
    const voidTx = fake.sent[0]!;

    // At close the head is stamped past closesAt, but the operator's RPC fails mid-push.
    fake.time = Math.floor(closesAt / 1000) + 1;
    fake.failNext.set('eth_getTransactionCount', 100);
    await alarmAt(r.stub, closesAt);
    expect(await voidRecord(r.stub)).toMatchObject({ state: 'requested' });
    expect((await readMeta(r.stub))?.done).not.toContain('close');

    // The RPC is back and answers definitely (unmined, and it can only revert now): abandoned, and
    // its voidRound is cancelled at its nonce (T4).
    fake.failNext.delete('eth_getTransactionCount');
    await alarmAt(r.stub, closesAt + 3_000);
    expect(await voidRecord(r.stub)).toMatchObject({ state: 'abandoned' });
    expect((await readMeta(r.stub))?.done).toContain('close');
    const cancel = fake.sent[fake.sent.length - 1]!;
    expect(cancel).toMatchObject({ nonce: voidTx.nonce, to: voidTx.from, data: '0x' });
  });

  it('off the local stack there is no blind grace: a block stamped before closesAt that appears late still confirms the void', async () => {
    queues = recordQueues();
    // Wall time: closesAt is a minute or two ago, far past the old 20 s grace.
    const closesAt = (Math.floor(Date.now() / 60_000) - 1) * 60_000;
    const fake = fakeChainAt(closesAt - 10_000);
    const r = await stakesRound(fake, { opensAt: closesAt - 24 * 3_600_000 });
    setClock(closesAt - 10_000);
    await r.stub.init(r.locked);
    fake.automine = false;
    await r.stub.requestVoid();
    await alarmAt(r.stub, closesAt - 9_000);
    expect(fake.pool.size).toBe(1);

    const runAlarms = () =>
      runInDurableObject(r.stub, async (i) => {
        await i.alarm();
        await i.alarm();
      });
    Object.assign(env, { ENVIRONMENT: 'staging' }); // the game clock is wall time now
    try {
      // The sequencer's head is still stamped before closesAt: close waits.
      fake.time = Math.floor(closesAt / 1000) - 5;
      await runAlarms();
      expect(await voidRecord(r.stub)).toMatchObject({ state: 'requested' });

      // Then it publishes a block stamped before closesAt, with our voidRound in it.
      fake.time = Math.floor(closesAt / 1000) - 4;
      fake.mine();
      await vi.waitFor(
        async () => {
          await runAlarms();
          expect(await voidRecord(r.stub)).toMatchObject({ state: 'confirmed', applied: true });
        },
        { timeout: 10_000, interval: 500 },
      );
    } finally {
      Object.assign(env, { ENVIRONMENT: 'local' });
    }
    for (const mode of ['free', 'stakes'] as const) {
      expect(await modeRow(r.locked.roundId, mode)).toMatchObject({
        status: 'voided',
        refund_reason: 4,
      });
    }
  });

  it('our own voidRound landing after its void was abandoned, with Free not voided, alerts', async () => {
    queues = recordQueues();
    const captured = captureAlerts();
    const closesAt = Date.UTC(2026, 9, 11, 1, 0, 0);
    const fake = fakeChainAt(closesAt - 10_000);
    const r = await stakesRound(fake, { opensAt: closesAt - 24 * 3_600_000 });
    setClock(closesAt - 10_000);
    await r.stub.init(r.locked);
    fake.escrowRounds.get(BigInt(r.chainRoundId))!.open = false; // every push is refused
    await r.stub.requestVoid();
    await alarmAt(r.stub, closesAt - 9_000);
    fake.time = Math.floor(closesAt / 1000);
    await alarmAt(r.stub, closesAt);
    expect(await voidRecord(r.stub)).toMatchObject({ state: 'abandoned' });

    // A voidRound of ours (the indexer finds it in sent_txs) is mirrored anyway.
    const evt = chainEvent('escrow', 'RoundRefunded', { roundId: r.chainRoundId, reason: '4' });
    await recordSentTx(env, {
      chainId: evt.chainId,
      txHash: evt.txHash,
      kind: 'voidRound',
      roundKey: null,
    });
    await commitStatements(await stakesVoidHandler(evt, env, { rpc: null as never }));
    captured.restore();
    expect(
      captured.alerts.filter((a) => a.code === 'ALERT_DO_ERROR' && a.roundId === r.locked.roundId),
    ).toMatchObject([{ step: 'void_landed_after_abandon', txHash: evt.txHash }]);
    // Stakes is voided as for a guardian void; Free goes on.
    expect((await modeRow(r.locked.roundId, 'stakes'))?.status).toBe('voided');
    expect((await modeRow(r.locked.roundId, 'free'))?.status).toBe('pending');
    expect((await r.stub.getState()).modes.stakes?.status).toBe('voided');
  });
});

describe('W4-F1: a void that can never confirm alerts (V2)', () => {
  it('a voidRound that reverts before close alerts once', async () => {
    queues = recordQueues();
    const captured = captureAlerts();
    const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
    const fake = fakeChainAt(t0);
    const r = await stakesRound(fake);
    setClock(t0);
    await r.stub.init(r.locked);
    fake.automine = false;
    await r.stub.requestVoid();
    await alarmAt(r.stub, t0 + 1_000);
    expect(fake.pool.size).toBe(1);
    // The escrow round is no longer Open when it is mined (say, a guardian void not indexed yet).
    fake.escrowRounds.get(BigInt(r.chainRoundId))!.open = false;
    fake.mine();
    await alarmAt(r.stub, t0 + 4_000);
    await alarmAt(r.stub, t0 + 8_000);
    captured.restore();
    const mine = captured.alerts.filter((a) => a.roundId === r.locked.roundId);
    expect(mine).toMatchObject([
      { code: 'ALERT_DO_ERROR', step: 'void_cannot_confirm', outcome: 'reverted' },
    ]);
    expect(await voidRecord(r.stub)).toMatchObject({ state: 'requested' });
  });

  it(`a voidRound refused ${VOID_REFUSED_ALERT_AFTER} times in a row alerts once`, async () => {
    queues = recordQueues();
    const captured = captureAlerts();
    const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
    const fake = fakeChainAt(t0);
    const r = await stakesRound(fake);
    setClock(t0);
    await r.stub.init(r.locked);
    fake.escrowRounds.get(BigInt(r.chainRoundId))!.open = false; // gas estimation reverts
    await r.stub.requestVoid();
    const alertsNow = () =>
      captured.alerts.filter(
        (a) => a.roundId === r.locked.roundId && a.step === 'void_cannot_confirm',
      );
    for (let i = 0; i < VOID_REFUSED_ALERT_AFTER - 1; i++) await alarmAt(r.stub, t0 + i * 3_000);
    expect(alertsNow()).toEqual([]);
    await alarmAt(r.stub, t0 + (VOID_REFUSED_ALERT_AFTER - 1) * 3_000);
    await alarmAt(r.stub, t0 + VOID_REFUSED_ALERT_AFTER * 3_000);
    captured.restore();
    expect(alertsNow()).toMatchObject([{ code: 'ALERT_DO_ERROR', outcome: 'refused' }]);
    expect(fake.sent).toHaveLength(0);
  });
});

describe('W4-F1: permanent handler conditions alert and return (V3)', () => {
  it('a guardian void the RoundDO has no Stakes mode for alerts instead of wedging dispatch', async () => {
    queues = recordQueues();
    const captured = captureAlerts();
    const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
    const fake = fakeChainAt(t0);
    const r = await stakesRound(fake, { modes: ['free'] });
    setClock(t0);
    await r.stub.init(r.locked);
    // D1 knows a Stakes mode the RoundDO was never given (a permanent mismatch).
    await env.DB.prepare(
      "INSERT INTO round_modes (round_id, mode, status, chain_round_id) VALUES (?1, 'stakes', 'pending', ?2)",
    )
      .bind(r.locked.roundId, r.chainRoundId)
      .run();
    const evt = chainEvent('escrow', 'RoundRefunded', { roundId: r.chainRoundId, reason: '4' });
    const stmts = await stakesVoidHandler(evt, env, { rpc: null as never });
    await commitStatements(stmts);
    captured.restore();
    expect(
      captured.alerts.filter((a) => a.roundId === r.locked.roundId && a.code === 'ALERT_DO_ERROR'),
    ).toMatchObject([{ step: 'stakes_void_mode_result' }]);
    expect((await modeRow(r.locked.roundId, 'stakes'))?.status).toBe('voided');
  });
});

describe('W5-F1: a void is abandoned at close only on proof', () => {
  it('a sent voidRound whose operator config breaks at close is not abandoned on that refusal (C3)', async () => {
    queues = recordQueues();
    const closesAt = Date.UTC(2026, 9, 14, 1, 0, 0);
    const fake = fakeChainAt(closesAt - 10_000);
    const r = await stakesRound(fake, { opensAt: closesAt - 24 * 3_600_000 });
    setClock(closesAt - 10_000);
    await r.stub.init(r.locked);
    fake.automine = false;
    await r.stub.requestVoid();
    await alarmAt(r.stub, closesAt - 9_000);
    expect(fake.pool.size).toBe(1); // sent: its operator_txs row exists

    // A redeploy leaves TX_MAX_FEE_GWEI invalid; at close the head is stamped past closesAt.
    fake.time = Math.floor(closesAt / 1000) + 1;
    Object.assign(env, { TX_MAX_FEE_GWEI: 'abc' });
    try {
      await alarmAt(r.stub, closesAt);
      expect(await voidRecord(r.stub)).toMatchObject({ state: 'requested' });
      expect((await readMeta(r.stub))?.done).not.toContain('close');
    } finally {
      delete (env as { TX_MAX_FEE_GWEI?: string }).TX_MAX_FEE_GWEI;
    }

    // Fixed: the push answers definitely again (unmined, and it can only revert now).
    await alarmAt(r.stub, closesAt + 3_000);
    expect(await voidRecord(r.stub)).toMatchObject({ state: 'abandoned' });
  });
});
