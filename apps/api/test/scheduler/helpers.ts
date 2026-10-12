// Scheduler test helpers: the game clock, questions, and a fake chain wired into the operator and the
// AnchorDO singleton.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import { generatePrivateKey } from 'viem/accounts';
import { vi } from 'vitest';
import { ANCHOR_SINGLETON, type AnchorDO } from '../../src/do/anchor-do.js';
import type { RoundRow } from '../../src/scheduler/lock.js';
import { FAKE_DEPLOYMENT, FakeChain } from '../anchor-do/fake-chain.js';
import { drand } from '../anchor-do/helpers.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function setClock(ms: number): void {
  Object.assign(env, { ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(ms) });
}

/** A question; house questions have no author. */
export async function insertQuestion(
  o: { author?: string | null; status?: string; score?: number; prompt?: string } = {},
): Promise<string> {
  const id = newUlid();
  await env.DB.prepare(
    'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, score, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
  )
    .bind(
      id,
      o.author ?? null,
      o.prompt ?? `Sheep or goats? ${id}`,
      JSON.stringify([
        { label: 'Sheep', emoji: '🐑' },
        { label: 'Goats', emoji: '🐐' },
      ]),
      'animals',
      o.status ?? 'queued',
      o.score ?? 0,
      0,
    )
    .run();
  return id;
}

export async function roundRow(id: string): Promise<RoundRow> {
  const r = await env.DB.prepare('SELECT * FROM rounds WHERE id = ?1').bind(id).first<RoundRow>();
  if (!r) throw new Error(`no round ${id}`);
  return r;
}

export async function modeRows(roundId: string) {
  const { results } = await env.DB.prepare(
    'SELECT mode, status, chain_round_id, lock_tx FROM round_modes WHERE round_id = ?1 ORDER BY mode',
  )
    .bind(roundId)
    .all<{ mode: string; status: string; chain_round_id: string | null; lock_tx: string | null }>();
  return results;
}

/** A fake chain behind the operator key and the AnchorDO singleton (alarms run by hand). */
export async function chainHarness(t: number) {
  const fake = new FakeChain({ genesis: drand.genesis, period: drand.period }, t / 1000);
  Object.assign(env, {
    CHAIN_ID: '31337',
    ANCHOR_KEY: generatePrivateKey(),
    OPERATOR_KEY: generatePrivateKey(),
    LOCAL_DEPLOYMENT: FAKE_DEPLOYMENT,
  });
  const anchor = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
  await runInDurableObject(anchor, (inst: AnchorDO) => {
    inst.transportOverride = fake.transport;
    inst.manualAlarms = true;
  });
  return {
    fake,
    anchor,
    deps: { operator: { transport: fake.transport, waitMs: 0 } },
    runAnchor: () => runDurableObjectAlarm(anchor),
  };
}

/**
 * The first write that marks `purpose` abandoned in operator_txs throws, as a D1 outage would, so
 * that cancellation fails before anything is sent (W5-F1 C4). Returns the spy (mockRestore it).
 */
export function failFirstMark(purpose: string) {
  const prepare = env.DB.prepare.bind(env.DB);
  let armed = true;
  return vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
    const stmt = prepare(sql);
    if (!armed || !sql.startsWith('UPDATE operator_txs SET tx_json')) return stmt;
    return {
      bind: (...args: unknown[]) => {
        if (args[0] === purpose && String(args[1]).includes('"abandoned":true')) {
          armed = false;
          throw new Error('D1_ERROR: unavailable');
        }
        return stmt.bind(...args);
      },
    } as unknown as D1PreparedStatement;
  });
}
