// PIPE-1 (bundle half), spec "API" › Reveal gating and docs/bundle-format.md: settlement writes a
// mode's bundle to R2 before the mode's `revealed_at` is set, and until it is set
// GET /api/v1/rounds/:id/bundles/:mode/:file answers 404 and GET /rounds/:id/verify lists nothing for
// the mode. After the reveal both serve: the objects byte for byte, write-once and immutable, at the
// URLs /verify lists, with keccak256(manifest bytes) = bundleHash. Modes refunded before any reveal
// (Free rules 4, 7, 8; Stakes rule 1) list no bundle, even when one is in R2. Bad file names are
// refused.
import { env } from 'cloudflare:test';
import {
  API_BASE_PATH,
  ErrorEnvelopeSchema,
  RoundVerifyResponseSchema,
  type Mode,
} from '@flocked/shared';
import { keccak256, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LockedRound } from '../../src/do/types.js';
import { applyVoid } from '../../src/lifecycle/void.js';
import { refundFree } from '../../src/settlement/apply/free.js';
import type { Manifest } from '../../src/settlement/types.js';
import { seedFixture } from '../helpers/index.js';
import { BEACON_TIME_MS, recordedDeps } from '../settlement/helpers.js';
import { eventsOf } from '../settlement/stakes-chain.js';
import { index, setGameClock, stakesEnv, stakesHarness } from '../settlement/stakes-helpers.js';
import {
  at,
  freeToWindow,
  get,
  modeRow,
  perOptionData,
  r2Bundle,
  seedFree,
  seedStakesRound,
  signIn,
  stakesToWindow,
} from './helpers.js';

beforeAll(async () => {
  await seedFixture(env.DB);
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

const IMMUTABLE = 'public, max-age=31536000, immutable';
const e = () => at(BEACON_TIME_MS + 10_000);

const bundlePath = (roundId: string, mode: Mode, file: string) =>
  `/rounds/${roundId}/bundles/${mode}/${file}`;

/** The R2 key's file name (`manifest.json`, `chunk-0000.json`). */
const fileOf = (key: string) => key.slice(key.lastIndexOf('/') + 1);

async function verify(roundId: string, headers: Record<string, string> = {}) {
  const a = await get(e(), `/rounds/${roundId}/verify`, headers);
  expect(a.status).toBe(200);
  return RoundVerifyResponseSchema.parse(a.json);
}

/** Before the reveal: R2 holds the bundle, and nothing of it is served or listed, to anyone. */
async function expectWithheld(
  roundId: string,
  mode: Mode,
  objects: Map<string, Uint8Array>,
  headers: Record<string, string>,
) {
  expect(objects.size).toBeGreaterThanOrEqual(2);
  for (const h of [{}, headers]) {
    for (const key of objects.keys()) {
      const a = await get(e(), bundlePath(roundId, mode, fileOf(key)), h);
      expect(a.status, key).toBe(404);
      expect(ErrorEnvelopeSchema.parse(a.json).error.code).toBe('not_found');
      expect(a.bytes).not.toEqual(objects.get(key));
    }
    expect(await verify(roundId, h)).toEqual({ roundId, modes: {} });
  }
}

/** After the reveal: /verify lists the bundle and every URL it gives serves R2's bytes, immutable. */
async function expectServed(
  roundId: string,
  mode: Mode,
  objects: Map<string, Uint8Array>,
  anchorTx: Hex | null,
) {
  const listed = (await verify(roundId)).modes[mode];
  if (!listed) throw new Error(`/verify lists no ${mode} bundle`);
  const manifestKey = `bundles/${roundId}/${mode}/manifest.json`;
  const manifestBytes = objects.get(manifestKey);
  if (!manifestBytes) throw new Error('no manifest in R2');
  expect(listed.bundleHash).toBe(keccak256(manifestBytes));
  expect(listed.anchorTx).toBe(anchorTx);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  expect(listed.manifestUrl).toBe(`${API_BASE_PATH}${bundlePath(roundId, mode, 'manifest.json')}`);
  expect(listed.chunkUrls).toEqual(
    manifest.chunks.map((c) => `${API_BASE_PATH}${bundlePath(roundId, mode, fileOf(c.key))}`),
  );
  // Every URL /verify gives resolves to R2's bytes, with the write-once cache headers.
  const urls = [listed.manifestUrl, ...listed.chunkUrls];
  expect(urls).toHaveLength(objects.size);
  for (const url of urls) {
    const a = await get(e(), url.slice(API_BASE_PATH.length));
    const key = `bundles/${roundId}/${mode}/${fileOf(url)}`;
    expect(a.status, url).toBe(200);
    expect(a.bytes).toEqual(objects.get(key));
    expect(a.headers.get('Cache-Control')).toBe(IMMUTABLE);
    expect(a.headers.get('Content-Type')).toBe('application/json');
  }
  // The chunks are the manifest's (docs/bundle-format.md "Verifying a bundle", step 1).
  for (const c of manifest.chunks) expect(keccak256(objects.get(c.key) as Uint8Array)).toBe(c.hash);
}

describe('PIPE-1 (bundle half): a Free bundle is in R2 before revealed_at but served only after it', () => {
  it('404 and an empty /verify in the window; after the reveal the objects, their URLs and bundleHash', async () => {
    const r = await seedFree([0, 1, 1]);
    const headers = await signIn(r.entries[0]?.userId as string);
    // Two entries per chunk: a manifest and two chunks.
    const window = await freeToWindow(r.roundId, { bundleChunk: 2 });
    const objects = await r2Bundle(r.roundId, 'free');
    expect([...objects.keys()].map(fileOf).sort()).toEqual([
      'chunk-0000.json',
      'chunk-0001.json',
      'manifest.json',
    ]);
    await expectWithheld(r.roundId, 'free', objects, headers);

    await window.reveal();
    expect((await modeRow(r.roundId, 'free'))?.revealed_at).not.toBeNull();
    // The bytes served are the ones written before the reveal (write-once).
    expect(await r2Bundle(r.roundId, 'free')).toEqual(objects);
    await expectServed(r.roundId, 'free', objects, null);
    const listed = (await verify(r.roundId)).modes.free;
    expect(listed).toMatchObject({ commitmentRoot: r.root, commitTx: r.commitTx });
  });
});

describe('PIPE-1 (bundle half): a Stakes bundle is in R2 before OutcomeProposed is indexed but served only after it', () => {
  it('404 and an empty /verify between propose and the indexer; after it the objects, their URLs and bundleHash', async () => {
    const r = await seedStakesRound([0, 0, 1, 1, 1]);
    const headers = await signIn(r.entries[0]?.userId as string);
    const window = await stakesToWindow(r);
    const objects = await r2Bundle(r.roundId, 'stakes');
    expect(objects.has(`bundles/${r.roundId}/stakes/manifest.json`)).toBe(true);
    await expectWithheld(r.roundId, 'stakes', objects, headers);

    await window.reveal();
    expect((await modeRow(r.roundId, 'stakes'))?.revealed_at).not.toBeNull();
    // Stakes: the bundle hash is the one proposed onchain, and anchorTx the proposal.
    const proposal = r.chain.lastTx('propose');
    expect(r.chain.round(r.chainRoundId).bundleHash).toBe(
      keccak256(objects.get(`bundles/${r.roundId}/stakes/manifest.json`) as Uint8Array),
    );
    await expectServed(r.roundId, 'stakes', objects, proposal);
    expect((await verify(r.roundId)).modes.stakes).toMatchObject({
      lockTx: null,
      commitmentRoot: null,
      commitTx: null,
    });
  });
});

describe('PIPE-1 (bundle half): modes refunded before the reveal list no bundle', () => {
  it('Free rule 4: voided after settlement wrote its bundle (and D1 outcomes): nothing served or listed, nothing per option anywhere', async () => {
    const r = await seedFree([0, 1, 1]);
    const entrant = r.entries[0]?.userId as string;
    const headers = await signIn(entrant);
    await freeToWindow(r.roundId);
    const objects = await r2Bundle(r.roundId, 'free');
    expect(objects.size).toBeGreaterThanOrEqual(2);
    const locked = { roundId: r.roundId, kind: 'daily', roomId: null, modes: ['free'] };
    await applyVoid(env, locked as unknown as LockedRound, BEACON_TIME_MS + 6_000);
    expect(await modeRow(r.roundId, 'free')).toMatchObject({ status: 'voided', revealed_at: null });

    await expectWithheld(r.roundId, 'free', objects, headers);
    for (const path of [`/rounds/${r.roundId}`, `/rounds/${r.roundId}/me`, '/rounds?limit=100']) {
      const a = await get(e(), path, headers);
      expect(a.status, path).toBe(200);
      const body =
        path === '/rounds?limit=100'
          ? (a.json as { rounds: { id: string }[] }).rounds.filter((x) => x.id === r.roundId)
          : a.json;
      expect(perOptionData(body), path).toEqual([]);
    }
    const me = (await get(e(), `/rounds/${r.roundId}/me`, headers)).json as {
      modes: { free: { result: string; payouts: { kind: string }[] } };
    };
    expect(me.modes.free.result).toBe('refund');
    // The void's refund only: not the win applyFree wrote before the void (src/read/me.ts fix).
    expect(me.modes.free.payouts.map((p) => p.kind)).toEqual(['refund']);
  });

  it.each([7, 8] as const)(
    'Free rule %i: refunded while pending: no bundle listed or served',
    async (rule) => {
      const r = await seedFree([0, 1, 1]);
      const headers = await signIn(r.entries[0]?.userId as string);
      await refundFree(env, r.roundId, rule, recordedDeps().deps);
      expect(await modeRow(r.roundId, 'free')).toMatchObject({
        status: 'refunded',
        revealed_at: null,
        bundle_hash: null,
      });
      for (const h of [{}, headers]) {
        expect(await verify(r.roundId, h)).toEqual({ roundId: r.roundId, modes: {} });
        for (const file of ['manifest.json', 'chunk-0000.json']) {
          expect((await get(e(), bundlePath(r.roundId, 'free', file), h)).status).toBe(404);
        }
      }
      const round = (await get(e(), `/rounds/${r.roundId}`)).json as {
        round: { modes: { free: { refundReason: number; settlement: unknown } } };
      };
      expect(round.round.modes.free).toMatchObject({ refundReason: rule, settlement: null });
    },
  );

  it('Stakes rule 1: refundTooFew after close: no bundle listed or served', async () => {
    const r = await seedStakesRound([0, 1]);
    r.chain.advanceTo(r.closesAt / 1000 + 4);
    setGameClock(r.closesAt + 5_000);
    const h = await stakesHarness(r);
    await h.start();
    for (let i = 0; i < 5 && (await h.alarm()).phase !== 'done'; i++);
    expect(r.chain.calls).toEqual([`refundTooFew:${r.chainRoundId}`]);
    await index(eventsOf(r.chain, r.chain.lastTx('refundTooFew')));
    expect(await modeRow(r.roundId, 'stakes')).toMatchObject({
      status: 'refunded',
      revealed_at: null,
    });
    expect((await r2Bundle(r.roundId, 'stakes')).size).toBe(0);
    expect(await verify(r.roundId)).toEqual({ roundId: r.roundId, modes: {} });
    expect((await get(e(), bundlePath(r.roundId, 'stakes', 'manifest.json'))).status).toBe(404);
  });
});

describe('bundle object names', () => {
  let revealed: string;

  beforeAll(async () => {
    const r = await seedFree([0, 1, 1]);
    const w = await freeToWindow(r.roundId);
    await w.reveal();
    revealed = r.roundId;
  });

  it('a revealed round still serves only its own well-formed objects', async () => {
    expect((await get(e(), bundlePath(revealed, 'free', 'manifest.json'))).status).toBe(200);
  });

  it.each([
    'manifest.JSON',
    'Manifest.json',
    'manifest',
    'chunk-1.json',
    'chunk-00000.json',
    'chunk-abcd.json',
    'chunk-0000.json.bak',
    'foo.json',
    '..%2Fmanifest.json',
    '..%2F..%2Fstakes%2Fmanifest.json',
  ])('%s: 400 bad_request', async (file) => {
    const a = await get(e(), bundlePath(revealed, 'free', file));
    expect(a.status).toBe(400);
    expect(ErrorEnvelopeSchema.parse(a.json).error.code).toBe('bad_request');
  });

  it.each(['%2E%2E', '..', '%2e%2e/%2e%2e/manifest.json'])(
    '%s: a dot segment the URL parser resolves away reaches no bundle object (404)',
    async (file) => {
      const a = await get(e(), bundlePath(revealed, 'free', file));
      expect(a.status).toBe(404);
      expect(ErrorEnvelopeSchema.parse(a.json).error.code).toBe('not_found');
    },
  );

  it.each(['both', 'FREE', 'points'])('mode %s: 400 bad_request', async (mode) => {
    const a = await get(e(), `/rounds/${revealed}/bundles/${mode}/manifest.json`);
    expect(a.status).toBe(400);
  });

  it('a well-formed name with no object (chunk-9999), or the round’s other mode: 404', async () => {
    expect((await get(e(), bundlePath(revealed, 'free', 'chunk-9999.json'))).status).toBe(404);
    expect((await get(e(), bundlePath(revealed, 'stakes', 'manifest.json'))).status).toBe(404);
  });

  it('an unknown round: 404; a malformed round ID: 400', async () => {
    const unknown = '01K7ZZZZZZZZZZZZZZZZZZZZZZ';
    expect((await get(e(), bundlePath(unknown, 'free', 'manifest.json'))).status).toBe(404);
    expect((await get(e(), bundlePath('not-a-ulid', 'free', 'manifest.json'))).status).toBe(400);
  });
});
