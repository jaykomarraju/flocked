import { describe, expect, it } from 'vitest';

import { BRAND, lossLine, VOICE, winLine } from '../src/index';

describe('brand vocabulary ("Overview": Brand vocabulary)', () => {
  it('has every term from the spec', () => {
    expect(Object.values(BRAND)).toEqual([
      'The Flock',
      'Got flocked',
      'Strays',
      'Unflocked',
      'Stray streak',
      'Play streak',
      'Game day',
    ]);
  });
});

describe('voice (Design_Language.md "Voice")', () => {
  it('never uses exclamation points', () => {
    for (const line of [...Object.values(VOICE), winLine(12), lossLine(88)]) {
      expect(line).not.toContain('!');
    }
  });

  it('templates reproduce the documented lines', () => {
    expect(winLine(38)).toBe(VOICE.win);
    expect(lossLine(61)).toBe(VOICE.loss);
  });
});
