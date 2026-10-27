// The watcher end to end inside workerd: one tick over its own D1, the signed verdicts it serves,
// and the guardian pages it sends. PIPE-5 (Stakes: match and mismatch) and ALERT-7 detection are
// proven here at the level the guardian actually sees.
import { env, SELF } from 'cloudflare:test';
import { generatePrivateKey } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSnapshot, getVerdict, proposalsFor, undeliveredPages } from '../src/db.js';
import { MISSING_VERDICT_MS } from '../src/page.js';
import { tick } from '../src/run.js';
import { verifyVerdict, watcherAddress, type Verdict } from '../src/verdict.js';
import { FakeApi, FakeChain, FakePager, fakeDeps, onchainConfigOf } from './fakes.js';
import {
  BEACON,
  CLOSES_AT,
  publishedRoundFor,
  republish,
  stakesFixture,
  type StakesFixture,
} from './fixture.js';

// @cloudflare/vitest-plugin gives one D1 per test FILE, so each test starts from an empty one.
beforeEach(async () => {
  for (const table of ['verdicts', 'proposals', 'pages', 'round_state', 'round_snapshots']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const KEY = generatePrivateKey();
const SIGNER = watcherAddress(KEY);
const PAGER_URL = 'https://pager.invalid/hook';
/** During the round: after it opened, before it closed. */
const DURING = (CLOSES_AT - 60 * 60) * 1000;
/** After the proposal, inside the challenge window. */
const AFTER_PROPOSAL = (CLOSES_AT + 10 * 60) * 1000;

interface World {
  api: FakeApi;
  chain: FakeChain;
  pager: FakePager;
  fixture: StakesFixture;
  objects: Map<string, Uint8Array>;
  watcherEnv: typeof env;
}

async function world(
  o: { objects?: (f: StakesFixture) => Map<string, Uint8Array>; serveRound?: boolean } = {},
): Promise<World> {
  const fixture = await stakesFixture();
  const objects = o.objects ? o.objects(fixture) : fixture.objects;
  const published = publishedRoundFor(fixture);
  const api = new FakeApi();
  if (o.serveRound !== false) {
    api.rounds = [published];
    api.todayId = published.id;
  }

  const chain = new FakeChain();
  const stakes = published.config.stakes;
  chain.created = {
    cfg: onchainConfigOf(stakes),
    txHash: `0x${'22'.repeat(32)}`,
    blockNumber: 10n,
  };
  chain.roundState = {
    status: 2,
    refundReason: 0,
    entryCount: fixture.manifest.entryCount,
    cfg: onchainConfigOf(stakes),
  };
  return {
    api,
    chain,
    pager: new FakePager(),
    fixture,
    objects,
    watcherEnv: {
      ...env,
      WATCHER_KEY: KEY,
      PAGER_WEBHOOK_URL: PAGER_URL,
      PAGER_WEBHOOK_TOKEN: 'test-pager-token',
    },
  };
}

/** The operator posts the round's proposal, as the bundle in `w.objects` has it. */
const PROPOSED_AT = CLOSES_AT + 5 * 60;
function propose(w: World): void {
  const log = w.fixture.reader.proposalLogs[0];
  if (!log) throw new Error('no proposal');
  w.chain.proposalLogs = [{ ...log, claimsOpenAt: BigInt(CLOSES_AT + 2 * 60 * 60) }];
  w.chain.times.set(log.blockNumber, PROPOSED_AT);
}

const run = (w: World, now: number) =>
  tick(
    w.watcherEnv,
    fakeDeps({
      api: w.api,
      chain: w.chain,
      reader: w.fixture.reader,
      objects: w.objects,
      pager: w.pager,
    }),
    now,
  );

describe('one watcher tick', () => {
  it('waits for a complete published config before snapshotting', async () => {
    const w = await world();
    const stakes = w.api.rounds[0]?.config?.stakes;
    if (!stakes) throw new Error('no published Stakes config');
    // The question has locked but `createRound` has not landed: chainRoundId is still "0".
    stakes.chainRoundId = '0';
    expect((await run(w, DURING)).snapshots).toBe(0);

    stakes.chainRoundId = String(w.fixture.chainRoundId);
    expect((await run(w, DURING + 60_000)).snapshots).toBe(1);
  });

  it('snapshots the published config once, and never reads it again', async () => {
    const w = await world();
    const first = await run(w, DURING);
    expect(first.snapshots).toBe(1);

    const snap = await getSnapshot(env.DB, w.fixture.roundId);
    expect(snap?.chainRoundId).toBe(String(w.fixture.chainRoundId));
    expect(snap?.snapshotAt).toBe(DURING);
    expect(snap?.config.stakes?.stake).toBe(String(w.fixture.config.stakes.stake));

    // The backend changes what it publishes; the watcher keeps the copy it took at lock.
    const republished = w.api.rounds[0]?.config?.stakes;
    if (!republished) throw new Error('no published Stakes config');
    republished.stake = '99000000';
    const second = await run(w, DURING + 60_000);
    expect(second.snapshots).toBe(0);
    expect((await getSnapshot(env.DB, w.fixture.roundId))?.config.stakes?.stake).toBe(
      String(w.fixture.config.stakes.stake),
    );
  });

  it('PIPE-5: an honest Stakes round is a match on RoundCreated and on the proposal, and pages nobody', async () => {
    const w = await world();
    const open = await run(w, DURING);
    expect(open.errors).toEqual([]);
    expect(open.verdicts).toEqual([
      { subject: 'stakes_round', roundId: w.fixture.roundId, verdict: 'match' },
    ]);

    propose(w);
    const summary = await run(w, AFTER_PROPOSAL);
    expect(summary.errors).toEqual([]);
    expect(summary.verdicts).toEqual([
      { subject: 'stakes_proposal', roundId: w.fixture.roundId, verdict: 'match' },
    ]);
    expect(w.pager.posts).toEqual([]);
    expect(await undeliveredPages(env.DB, 10)).toEqual([]);

    const v = await getVerdict(env.DB, 'stakes_proposal', w.fixture.roundId);
    expect(v?.verdict).toBe('match');
    await expect(verifyVerdict(v as Verdict, SIGNER)).resolves.toBe(true);
    expect(await proposalsFor(env.DB, w.fixture.roundId)).toHaveLength(1);
  });

  it('ALERT-7: a proposal whose bundle does not recompute is a mismatch, and pages the guardian', async () => {
    const w = await world({
      objects: (f) =>
        republish(f, {
          manifest: (m) => {
            m.payoutRoot = `0x${'ab'.repeat(32)}`;
          },
        }),
    });
    await run(w, DURING);
    // The proposal posts the tampered manifest, so only the recompute can catch it.
    propose(w);
    const summary = await run(w, AFTER_PROPOSAL);
    expect(summary.verdicts).toContainEqual({
      subject: 'stakes_proposal',
      roundId: w.fixture.roundId,
      verdict: 'mismatch',
    });

    const v = await getVerdict(env.DB, 'stakes_proposal', w.fixture.roundId);
    expect(v?.verdict).toBe('mismatch');
    expect(v?.reasons.join('\n')).toContain('fail payoutRoot');
    await expect(verifyVerdict(v as Verdict, SIGNER)).resolves.toBe(true);

    expect(summary.delivered).toBe(1);
    expect(w.pager.posts).toHaveLength(1);
    const post = w.pager.posts[0];
    expect(post?.url).toBe(PAGER_URL);
    expect(post?.auth).toBe('Bearer test-pager-token');
    expect(post?.body).toMatchObject({ kind: 'verdict', verdict: { verdict: 'mismatch' } });
  });

  it('ALERT-7: a RoundCreated the published config does not match pages before close', async () => {
    const w = await world();
    // Seen onchain with twenty times the published stake.
    w.chain.created = {
      ...(w.chain.created ?? { txHash: `0x${'22'.repeat(32)}`, blockNumber: 10n }),
      cfg: { ...onchainConfigOf(publishedRoundFor(w.fixture).config.stakes), stake: 100_000_000n },
    };
    const summary = await run(w, DURING);
    expect(summary.verdicts).toContainEqual({
      subject: 'stakes_round',
      roundId: w.fixture.roundId,
      verdict: 'mismatch',
    });
    const v = await getVerdict(env.DB, 'stakes_round', w.fixture.roundId);
    expect(v?.reasons.join('\n')).toContain('fail created.stake');
    expect(w.pager.posts).toHaveLength(1);
    // Paged while the round is still open, so the guardian can still void it.
    expect(DURING).toBeLessThan(CLOSES_AT * 1000);
  });

  it('a verdict is written once: a later tick neither changes it nor pages twice', async () => {
    const w = await world({
      objects: (f) =>
        republish(f, {
          manifest: (m) => {
            m.payoutRoot = `0x${'ab'.repeat(32)}`;
          },
        }),
    });
    await run(w, DURING);
    propose(w);
    await run(w, AFTER_PROPOSAL);
    const first = await getVerdict(env.DB, 'stakes_proposal', w.fixture.roundId);
    const second = await run(w, AFTER_PROPOSAL + 60_000);
    expect(second.verdicts).toEqual([]);
    expect(await getVerdict(env.DB, 'stakes_proposal', w.fixture.roundId)).toEqual(first);
    expect(w.pager.posts).toHaveLength(1);
  });

  it('keeps an unresolved check open instead of publishing a premature "unable"', async () => {
    const w = await world();
    w.chain.created = null; // the chain has not caught up with the published config
    const early = await run(w, DURING);
    expect(early.verdicts).toEqual([]);
    expect(await getVerdict(env.DB, 'stakes_round', w.fixture.roundId)).toBeNull();

    // Close is near: the guardian needs an answer even when it is "unable".
    const late = await run(w, (CLOSES_AT - 5 * 60) * 1000);
    expect(late.verdicts).toEqual([
      { subject: 'stakes_round', roundId: w.fixture.roundId, verdict: 'unable' },
    ]);
    expect(w.pager.posts).toHaveLength(1);
    expect(w.pager.posts[0]?.body).toMatchObject({ verdict: { verdict: 'unable' } });
  });

  it('a page survives an unreachable webhook and goes out on the next tick', async () => {
    const w = await world();
    w.chain.created = null;
    w.pager.status = 503;
    const first = await run(w, (CLOSES_AT - 5 * 60) * 1000);
    expect(first.failed).toBe(1);
    expect(first.delivered).toBe(0);
    expect(await undeliveredPages(env.DB, 10)).toHaveLength(1);

    w.pager.status = 200;
    const second = await run(w, (CLOSES_AT - 4 * 60) * 1000);
    expect(second.delivered).toBe(1);
    expect(await undeliveredPages(env.DB, 10)).toEqual([]);
    expect(w.pager.posts).toHaveLength(2);
  });

  it('an unreachable API stops nothing it has already snapshotted', async () => {
    const w = await world();
    await run(w, DURING);
    propose(w);
    w.api.down = new Error('api unreachable');
    const summary = await run(w, AFTER_PROPOSAL);
    expect(summary.errors.join(' ')).toContain('api unreachable');
    expect(await getVerdict(env.DB, 'stakes_round', w.fixture.roundId)).not.toBeNull();
  });
});

describe('the 30-minute missing-verdict rule', () => {
  const proposedAt = PROPOSED_AT;

  async function recordBareProposal(roundId: string) {
    await env.DB.prepare(
      `INSERT INTO proposals (round_id, chain_round_id, bundle_hash, tx_hash, block_number,
                              proposed_at, seen_at)
       VALUES (?1, '7', ?2, ?3, 200, ?4, ?5)`,
    )
      .bind(roundId, `0x${'ee'.repeat(32)}`, `0x${'ff'.repeat(32)}`, proposedAt, proposedAt * 1000)
      .run();
  }

  it('pages nobody while the window is still open', async () => {
    const w = await world({ serveRound: false });
    await recordBareProposal('01K8V3R4N5P6Q7S8T9VWXYZABD');
    const summary = await run(w, proposedAt * 1000 + MISSING_VERDICT_MS - 60_000);
    expect(summary.paged).toBe(0);
    expect(w.pager.posts).toEqual([]);
  });

  it('pages once when no verdict covers a proposal 30 minutes on', async () => {
    const w = await world({ serveRound: false });
    const roundId = '01K8V3R4N5P6Q7S8T9VWXYZABD';
    await recordBareProposal(roundId);
    const summary = await run(w, proposedAt * 1000 + MISSING_VERDICT_MS);
    expect(summary.paged).toBe(1);
    expect(w.pager.posts[0]?.body).toMatchObject({
      kind: 'missing_verdict',
      roundId,
      mode: 'stakes',
      noVerdictAfterMs: MISSING_VERDICT_MS,
    });

    const again = await run(w, proposedAt * 1000 + MISSING_VERDICT_MS + 120_000);
    expect(again.paged).toBe(0);
    expect(w.pager.posts).toHaveLength(1);
  });
});

describe('the verdict route', () => {
  it('serves a stored verdict, and 404s for anything else', async () => {
    const w = await world();
    await run(w, DURING);
    propose(w);
    await run(w, AFTER_PROPOSAL);

    const res = await SELF.fetch(
      `https://watcher.test/verdicts/stakes_proposal/${w.fixture.roundId}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json<Verdict>();
    expect(body.verdict).toBe('match');
    expect(body.mode).toBe('stakes');
    expect(body.roundId).toBe(w.fixture.roundId);
    await expect(verifyVerdict(body, SIGNER)).resolves.toBe(true);

    expect((await SELF.fetch('https://watcher.test/verdicts/stakes_proposal/01NOPE')).status).toBe(
      404,
    );
    expect(
      (await SELF.fetch(`https://watcher.test/verdicts/made_up/${w.fixture.roundId}`)).status,
    ).toBe(404);
    expect((await SELF.fetch('https://watcher.test/anything')).status).toBe(404);
    expect(
      (
        await SELF.fetch(`https://watcher.test/verdicts/stakes_proposal/${w.fixture.roundId}`, {
          method: 'POST',
        })
      ).status,
    ).toBe(405);
  });

  it('reports its configuration without leaking the paging URL', async () => {
    const res = await SELF.fetch('https://watcher.test/health');
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    // The deployed WATCHER_KEY is a secret the owner sets (OA-15); there is none in the test env.
    expect(body).toMatchObject({ ok: false, environment: 'local', chainId: 31337, pager: false });
    expect(JSON.stringify(body)).not.toContain('pager.invalid');
  });
});

describe('the drand beacon the picks target', () => {
  it('is the one the manifest names, verified against the pinned chain', async () => {
    const w = await world();
    expect(w.fixture.manifest.drand.signature).toBe(BEACON.signature);
    await run(w, DURING);
    propose(w);
    await run(w, AFTER_PROPOSAL);
    const v = await getVerdict(env.DB, 'stakes_proposal', w.fixture.roundId);
    expect(v?.reasons.join('\n')).toContain('pass drand.signature');
  });
});
