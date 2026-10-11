// W4-D registrations: the cron jobs run the real scheduler and indexer kick, and every transaction
// the backend signs (AnchorDO and operator) is in sent_txs before it is broadcast (wave-4 pinned
// interfaces: chain/tx.ts `onTxSent` → W4-B's recordSentTx).
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TxSentEvent } from '../../src/chain/tx.js';
import { CRON_HANDLERS } from '../../src/cron.js';
import { ANCHOR_SINGLETON, type AnchorDO } from '../../src/do/anchor-do.js';
import { indexerKick } from '../../src/indexer/cron.js';
import { isSentTx } from '../../src/indexer/sent.js';
import { operatorDeps, sentTxKindOf, sentTxRecorder } from '../../src/lifecycle/sent.js';
import { SCHEDULER_JOBS } from '../../src/scheduler/index.js';

const HASH = `0x${'5e'.repeat(32)}` as const;

describe('W4-D wiring', () => {
  it('registers the scheduler and the indexer kick; reconciliation stays W5-D', () => {
    expect(CRON_HANDLERS.scheduler_tick).toBe(SCHEDULER_JOBS.scheduler_tick);
    expect(CRON_HANDLERS.create_rounds_ahead).toBe(SCHEDULER_JOBS.create_rounds_ahead);
    expect(CRON_HANDLERS.indexer_kick).toBe(indexerKick);
  });

  it('maps every transaction label to its sent_txs kind and refuses unknown ones', () => {
    expect(sentTxKindOf('anchor.lock')).toBe('lock');
    expect(sentTxKindOf('anchor.commit')).toBe('commit');
    expect(sentTxKindOf('anchor.manifest')).toBe('manifest');
    expect(sentTxKindOf('operator.createRound')).toBe('createRound');
    expect(sentTxKindOf('operator.voidRound')).toBe('voidRound');
    expect(sentTxKindOf('operator.finalize')).toBe('finalize');
    expect(() => sentTxKindOf('operator.transfer')).toThrow(/no sent_txs kind/);
    expect(() => sentTxKindOf('commit')).toThrow(/no sent_txs kind/);
  });

  it('records a transaction before broadcast, for the AnchorDO and the operator', async () => {
    const event: TxSentEvent = {
      chainId: 31337,
      hash: HASH,
      from: '0x00000000000000000000000000000000000000a1',
      to: '0x00000000000000000000000000000000000000a2',
      nonce: 0,
      label: 'operator.voidRound',
      replaces: [],
    };
    await operatorDeps(env).onTxSent?.(event);
    expect(await isSentTx(env.DB, 31337, HASH)).toBe(true);

    const anchor = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
    const wired = await runInDurableObject(anchor, (inst: AnchorDO) => typeof inst.onTxSent);
    expect(wired).toBe('function');
    const other = `0x${'6f'.repeat(32)}` as const;
    await runInDurableObject(anchor, (inst: AnchorDO) =>
      inst.onTxSent?.({ ...event, hash: other, label: 'anchor.commit' }),
    );
    const row = await env.DB.prepare('SELECT kind FROM sent_txs WHERE tx_hash = ?1')
      .bind(other)
      .first<{ kind: string }>();
    expect(row?.kind).toBe('commit');
    // An unknown label stops the broadcast (TxSender awaits the callback before sending).
    expect(() => sentTxRecorder(env)({ ...event, label: 'bogus' })).toThrow(/no sent_txs kind/);
  });
});
