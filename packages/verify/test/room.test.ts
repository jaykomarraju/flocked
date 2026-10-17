// Room bundles (W8-D): rule 1 counts only entries with `qualifies`, so a non-qualifying entrant can
// change the outcome. The verifier passes the bundle's flags to settle with countQualifyingOnly.
import { describe, expect, it } from 'vitest';
import { ids, manifestOf, republish, verify } from './helpers.js';
import { makeBundle } from './pipeline.js';

const HOUR = 60 * 60 * 1000;

describe('room bundles', () => {
  it('a non-qualifying entrant (account under 24 h) leaves the room under its minimum: refunded, rule 1', async () => {
    const entries = [
      { option: 0 as const },
      { option: 1 as const },
      { option: 1 as const, ageMs: HOUR },
    ];
    const f = await makeBundle('free', { kind: 'room', entries });
    expect([f.outcome, f.refundReason]).toEqual(['refunded', 1]);
    expect(manifestOf(f).chunks.length).toBe(1);
    const r = await verify(f);
    expect(ids(r)).toEqual([]);
    expect(r.verdict).toBe('match');
    expect(r.record?.outcome).toBe('refunded');

    // The same entrants, all old enough: the room settles.
    const g = await makeBundle('free', {
      kind: 'room',
      entries: entries.map((e) => ({ option: e.option })),
    });
    expect(g.outcome).toBe('settled');
    expect((await verify(g)).verdict).toBe('match');
  });

  it('flipping the non-qualifying flag changes the recomputed outcome, so the record no longer matches', async () => {
    const f = await makeBundle('free', {
      kind: 'room',
      entries: [{ option: 0 }, { option: 1 }, { option: 1, ageMs: HOUR }],
    });
    const objects = republish(f, {
      chunk: (c) => {
        for (const e of c.entries) e.qualifies = true;
      },
    });
    const r = await verify(f, objects);
    expect(r.verdict).toBe('mismatch');
    expect(r.record?.outcome).toBe('settled');
    expect(ids(r)).toContain('record');
  });

  it('one account entering twice is a mismatch, not a crash', async () => {
    const f = await makeBundle('free', {
      kind: 'room',
      entries: [{ option: 0 }, { option: 1 }, { option: 1 }],
    });
    const objects = republish(f, {
      chunk: (c) => {
        const [a, b] = c.entries;
        if (a && b) b.account = a.account;
      },
    });
    const r = await verify(f, objects);
    expect(r.verdict).toBe('mismatch');
    expect(ids(r)).toContain('record');
  });

  it('a VOID entry never qualifies', async () => {
    const f = await makeBundle('stakes', {
      kind: 'room',
      entries: [{ option: 0 }, { option: 1 }, { option: 1 }, { sealed: 'garbage' }],
    });
    expect(f.outcome).toBe('settled');
    expect((await verify(f)).verdict).toBe('match');
    const objects = republish(f, {
      chunk: (c) => {
        for (const e of c.entries) e.qualifies = true;
      },
    });
    expect(ids(await verify(f, objects))).toContain('entry.qualifies');
  });
});
