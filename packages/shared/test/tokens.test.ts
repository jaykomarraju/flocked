import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DesignTokensSchema } from '../src/index';

const raw: unknown = JSON.parse(
  readFileSync(new URL('../design-tokens.json', import.meta.url), 'utf8'),
);

describe('design-tokens.json (wave-2 plan P2.3)', () => {
  it('matches the P2.3 schema', () => {
    const result = DesignTokensSchema.safeParse(raw);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('keeps the Design_Language.md colours (changes need a Z-raised decision)', () => {
    const tokens = DesignTokensSchema.parse(raw);
    expect(tokens.color.light).toEqual({
      bg: '#FAF7F2',
      surface: '#FFFFFF',
      ink: '#141414',
      muted: '#8A8A8A',
      line: '#E6E1D8',
      accent: '#FF4F2E',
      accentInk: '#FFFFFF',
    });
    // Dark `accentInk` isn't in the design language; W2-C picked it (spec issue for Z).
    expect(tokens.color.dark).toEqual({
      bg: '#121212',
      surface: '#1C1C1C',
      ink: '#F5F2EC',
      muted: '#9A9A9A',
      line: '#2C2C2C',
      accent: '#FF5A3A',
      accentInk: tokens.color.dark.accentInk,
    });
  });

  it('has ascending spacing and breakpoints', () => {
    const tokens = DesignTokensSchema.parse(raw);
    expect([...tokens.space].sort((a, b) => a - b)).toEqual(tokens.space);
    const { min, tablet, desktop } = tokens.breakpoints;
    expect(min < tablet && tablet < desktop).toBe(true);
  });

  it('rejects unknown keys and lowercase hex', () => {
    expect(DesignTokensSchema.safeParse({ ...(raw as object), extra: 1 }).success).toBe(false);
    const tokens = DesignTokensSchema.parse(raw);
    const bad = {
      ...tokens,
      color: { ...tokens.color, light: { ...tokens.color.light, bg: '#faf7f2' } },
    };
    expect(DesignTokensSchema.safeParse(bad).success).toBe(false);
  });
});
