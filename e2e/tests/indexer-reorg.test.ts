// Chain indexer against the local stack's anvil (W4-B): every FlockedEscrow and FlockedAnchor event
// mirrored, PIPE-3 (a reorg made with evm_snapshot / evm_revert, repaired), idempotent dispatch across
// the replay, and ALERT-8 on a real transaction the backend didn't record.
//
// The indexer core (apps/api/src/indexer) runs here in Node over the stack's anvil and its real
// deployments, through the same viem RPC client the IndexerDO uses. D1 is node:sqlite with the
// apps/api migrations applied, so the test never writes to the stack's own D1. (Driving the IndexerDO
// inside `wrangler dev` needs the cron registration and a seam route, both W4-D.)
//
//   pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/indexer-reorg.test.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { flockedAnchorAbi } from '@flocked/abi';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { API_DIR, readDevVars, readState } from '../stack/env.mjs';

interface StackState {
  ready: boolean;
  drand: { genesis: number; period: number };
  anvil: { rpcUrl: string; chainId: number };
}

const state = readState() as StackState | null;
const vars = readDevVars() as Record<string, string> | null;
if (!state?.ready || !vars) throw new Error('the local stack is not up: run `pnpm stack:up` first');
const ANCHOR_KEY = vars.ANCHOR_KEY as Hex;
const LOCAL_DEPLOYMENT = vars.LOCAL_DEPLOYMENT!;
const deployment = JSON.parse(LOCAL_DEPLOYMENT) as {
  escrow: Hex;
  anchor: Hex;
  deployBlock: number;
};
const rpcUrl = state.anvil.rpcUrl;

// --- D1 over node:sqlite (the subset the indexer uses) ---------------------------------------------

type SqlValue = null | number | bigint | string | Uint8Array;

class NodeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: SqlValue[] = [],
  ) {}

  bind(...params: unknown[]): NodeStatement {
    return new NodeStatement(
      this.db,
      this.sql,
      params.map((p) => (p === undefined ? null : (p as SqlValue))),
    );
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve(
      (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null,
    );
  }

  all<T>(): Promise<{ results: T[]; success: true }> {
    return Promise.resolve({
      results: this.db.prepare(this.sql).all(...this.params) as T[],
      success: true,
    });
  }

  runSync(): { success: true; meta: { changes: number } } {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }

  run(): Promise<{ success: true; meta: { changes: number } }> {
    return Promise.resolve(this.runSync());
  }
}

class NodeD1 {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): NodeStatement {
    return new NodeStatement(this.db, sql);
  }

  /** Atomic, as D1's batch is. */
  batch(stmts: NodeStatement[]) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.runSync());
      this.db.exec('COMMIT');
      return Promise.resolve(out);
    } catch (err) {
      this.db.exec('ROLLBACK');
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// --- The apps/api indexer modules (loaded at runtime; e2e doesn't typecheck apps/api) ---------------

interface ChainEvt {
  txHash: Hex;
  event: string;
  removed: boolean;
  revision: number;
}
interface Registry {
  register(event: string, name: string, fn: (evt: ChainEvt) => Promise<void>): void;
}
interface IndexerModules {
  config: {
    indexerConfig(
      env: object,
    ):
      { ok: true; config: { chainId: number; targets: unknown[] } } | { ok: false; reason: string };
  };
  rpc: { viemIndexerRpc(env: object): unknown };
  core: {
    indexOnce(o: object): Promise<{ reorg: boolean; toBlock: number; events: number }>;
  };
  dispatch: {
    dispatchPending(env: object, registry: Registry, o: object): Promise<{ failed: unknown }>;
  };
  handlers: {
    HandlerRegistry: new () => Registry;
    registerBuiltinHandlers(r: Registry): Registry;
    ANY_EVENT: string;
  };
  sent: { recordSentTx(env: object, tx: object): Promise<void> };
}

async function loadIndexer(): Promise<IndexerModules> {
  const dir = join(API_DIR, 'src', 'indexer');
  const load = async <K extends keyof IndexerModules>(file: string) =>
    (await import(/* @vite-ignore */ join(dir, file))) as IndexerModules[K];
  return {
    config: await load<'config'>('config.ts'),
    rpc: await load<'rpc'>('rpc.ts'),
    core: await load<'core'>('core.ts'),
    dispatch: await load<'dispatch'>('dispatch.ts'),
    handlers: await load<'handlers'>('handlers.ts'),
    sent: await load<'sent'>('sent.ts'),
  };
}

// --- The test --------------------------------------------------------------------------------------

interface AlertPoint {
  code: string;
  data: Record<string, unknown>;
}

const account = privateKeyToAccount(ANCHOR_KEY);
const client = createPublicClient({
  chain: foundry,
  transport: http(rpcUrl),
  pollingInterval: 200,
});
const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });

async function anvil(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

describe('chain indexer on the local stack', () => {
  let m: IndexerModules;
  let d1: NodeD1;
  let env: Record<string, unknown>;
  let chainId: number;
  let targets: unknown[];
  let rpc: unknown;
  let registry: Registry;
  const alerts: AlertPoint[] = [];
  const seen: ChainEvt[] = [];
  const recorded = new Set<string>();

  const cycle = async () => {
    const r = await m.core.indexOnce({ db: d1, rpc, chainId, targets, nowMs: Date.now() });
    const d = await m.dispatch.dispatchPending(env, registry, {
      chainId,
      targets,
      rpc,
      nowMs: Date.now(),
    });
    expect(d.failed).toBeNull();
    return r;
  };

  /** Every log both contracts emitted since the deploy block, from anvil directly. */
  const chainLogs = async () =>
    (
      await client.getLogs({
        address: [deployment.escrow, deployment.anchor],
        fromBlock: BigInt(deployment.deployBlock),
        toBlock: 'latest',
      })
    ).map((l) => ({
      tx_hash: l.transactionHash.toLowerCase(),
      log_index: l.logIndex,
      block_hash: l.blockHash.toLowerCase(),
    }));

  const liveRows = () =>
    d1.db
      .prepare(
        `SELECT tx_hash, log_index, block_hash FROM chain_events
         WHERE chain_id = ?1 AND removed = 0 ORDER BY block_number, log_index`,
      )
      .all(chainId);

  /** Sends one FlockedAnchor.lock from the stack's anchorer key; `record` puts it in sent_txs first. */
  async function sendLock(tag: string, record: boolean): Promise<Hex> {
    const key = keccak256(toHex(`indexer-e2e:${tag}:${Date.now()}`));
    const closesAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const beaconRound =
      BigInt(Math.ceil((Number(closesAt) + 120 - state!.drand.genesis) / state!.drand.period)) + 1n;
    const request = await wallet.prepareTransactionRequest({
      to: deployment.anchor,
      data: encodeFunctionData({
        abi: flockedAnchorAbi,
        functionName: 'lock',
        args: [
          [key],
          [closesAt],
          [beaconRound],
          [keccak256(toHex(tag))],
          [keccak256(toHex('cfg'))],
        ],
      }),
    });
    const signed = await wallet.signTransaction(request);
    const hash = keccak256(signed);
    if (record) {
      await m.sent.recordSentTx(env, { chainId, txHash: hash, kind: 'lock', roundKey: key });
      recorded.add(hash);
    }
    await client.sendRawTransaction({ serializedTransaction: signed });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const [log] = receipt.logs;
    const evt = decodeEventLog({ abi: flockedAnchorAbi, data: log!.data, topics: log!.topics });
    expect(['Locked', 'Skipped']).toContain(evt.eventName);
    return hash;
  }

  beforeAll(async () => {
    m = await loadIndexer();
    const db = new DatabaseSync(':memory:');
    const migrations = join(API_DIR, 'migrations');
    for (const f of readdirSync(migrations)
      .filter((x) => x.endsWith('.sql'))
      .sort()) {
      db.exec(readFileSync(join(migrations, f), 'utf8'));
    }
    d1 = new NodeD1(db);
    env = {
      DB: d1,
      ENVIRONMENT: 'local',
      CHAIN_ID: String(state.anvil.chainId),
      LOCAL_DEPLOYMENT,
      BASE_RPC_URL: rpcUrl,
      ANALYTICS: {
        writeDataPoint: (p: { blobs: string[] }) =>
          alerts.push({
            code: p.blobs[0]!,
            data: JSON.parse(p.blobs[3]!) as Record<string, unknown>,
          }),
      },
    };
    const cfg = m.config.indexerConfig(env);
    if (!cfg.ok) throw new Error(cfg.reason);
    ({ chainId, targets } = cfg.config);
    rpc = m.rpc.viemIndexerRpc(env);
    registry = m.handlers.registerBuiltinHandlers(new m.handlers.HandlerRegistry());
    registry.register(m.handlers.ANY_EVENT, 'e2e-recorder', (evt) => {
      seen.push({
        txHash: evt.txHash,
        event: evt.event,
        removed: evt.removed,
        revision: evt.revision,
      });
      return Promise.resolve();
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('mirrors every escrow and anchor event since the deploy block', async () => {
    await sendLock('mirror', true);
    await cycle();
    const logs = await chainLogs();
    expect(liveRows()).toEqual(logs);
    // The constructors' events (role grants, ticket signer, treasury, receipt signer) are there.
    const names = d1.db.prepare('SELECT DISTINCT event FROM chain_events').all() as {
      event: string;
    }[];
    expect(names.map((n) => n.event)).toEqual(
      expect.arrayContaining(['RoleGranted', 'TicketSignerSet', 'TreasurySet', 'ReceiptSignerSet']),
    );
    // Constructor events (through the CREATE2 factory) and recorded backend transactions are quiet.
    const quiet = alerts.filter(
      (a) => a.code === 'ALERT_FOREIGN_EVENT' && !recorded.has(String(a.data.txHash)),
    );
    const deployTxs = new Set<string>();
    for (const l of logs) {
      const tx = await client.getTransaction({ hash: l.tx_hash as Hex });
      if (tx.to?.toLowerCase() === '0x4e59b44847b379578588920ca78fbf26c0b4956c') {
        deployTxs.add(l.tx_hash);
      }
    }
    expect(deployTxs.size).toBeGreaterThan(0);
    expect(quiet.filter((a) => deployTxs.has(String(a.data.txHash)))).toEqual([]);
    expect(alerts.filter((a) => recorded.has(String(a.data.txHash)))).toEqual([]);
  });

  it('PIPE-3: repairs a reorg made with evm_snapshot / evm_revert', async () => {
    const snapshot = await anvil('evm_snapshot');
    const dropped = await sendLock('dropped', true);
    await anvil('anvil_mine', ['0x1']);
    await cycle();
    expect(seen.filter((s) => s.txHash === dropped).map((s) => [s.removed, s.revision])).toEqual([
      [false, 0],
    ]);

    // Back to before `dropped`, then a different chain of at least as many blocks.
    expect(await anvil('evm_revert', [snapshot])).toBe(true);
    const kept = await sendLock('kept', true);
    await anvil('anvil_mine', ['0x3']);
    const r = await cycle();
    expect(r.reorg).toBe(true);

    // chain_events now matches the chain: `dropped` is removed, `kept` is live.
    expect(liveRows()).toEqual(await chainLogs());
    const row = (tx: string) =>
      d1.db.prepare('SELECT removed, revision FROM chain_events WHERE tx_hash = ?1').get(tx) as {
        removed: number;
        revision: number;
      };
    expect(row(dropped)).toEqual({ removed: 1, revision: 1 });
    expect(row(kept)).toEqual({ removed: 0, revision: 0 });
    expect(seen.filter((s) => s.txHash === dropped).map((s) => s.removed)).toEqual([false, true]);
    expect(seen.filter((s) => s.txHash === kept).map((s) => s.removed)).toEqual([false]);

    // Replaying the whole range dispatches nothing again.
    const before = seen.length;
    d1.db.exec('DELETE FROM indexer_state');
    await cycle();
    expect(seen.length).toBe(before);
    expect(liveRows()).toEqual(await chainLogs());
  });

  it('ALERT-8: an anchor event from a transaction the backend did not record', async () => {
    const foreign = await sendLock('foreign', false);
    await cycle();
    const raised = alerts.filter(
      (a) => a.code === 'ALERT_FOREIGN_EVENT' && a.data.txHash === foreign,
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.data).toMatchObject({
      kind: 'unsent_tx',
      contractKind: 'anchor',
      from: account.address.toLowerCase(),
    });
  });
});
