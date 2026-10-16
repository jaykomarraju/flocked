import { describe, expect, it } from 'vitest';
import { kebab, themeCss } from './css';
import { breakpointFor, tokens } from './index';

const css = themeCss(tokens, {
  display: [{ url: '/f.woff2', weight: [300, 700], unicodeRange: 'U+0000-00FF' }],
  body: [{ url: '/i.woff2', weight: [100, 900], unicodeRange: 'U+0000-00FF' }],
});

describe('theme from design-tokens.json', () => {
  it('names custom properties as Paper does', () => {
    expect(kebab('accentInk')).toBe('accent-ink');
    expect(kebab('numberXL')).toBe('number-xl');
    expect(kebab('bodyStrong')).toBe('body-strong');
  });

  it('emits every light and dark colour from the tokens', () => {
    for (const [name, value] of Object.entries(tokens.color.light)) {
      expect(css).toContain(`--color-${kebab(name)}: ${value};`);
    }
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    for (const [name, value] of Object.entries(tokens.color.dark)) {
      expect(dark).toContain(`--color-${kebab(name)}: ${value};`);
    }
  });

  it('emits a class per type role with its size, line height, weight and tracking', () => {
    expect(css).toContain(
      '.type-caption { font-family: var(--font-body); font-size: var(--text-caption); line-height: 18px; font-weight: 500; letter-spacing: 0.01em; font-variation-settings: "opsz" 26; }',
    );
    expect(css).toContain('--text-number-xl: 32px;');
    expect(css).toMatch(/\.type-number-xl \{[^}]*font-feature-settings: "tnum";/);
  });

  it('declares the self-hosted families under the token names, and the mono stack', () => {
    expect(css).toContain(
      'font-family: "Fredoka"; font-style: normal; font-display: block; font-weight: 300 700;',
    );
    expect(css).toContain('font-family: "Inter"');
    expect(css).toContain('--font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;');
  });

  it("pins Inter's optical size below the body size to the doubled size, as Paper's 2x exports", () => {
    expect(css).toMatch(/\.type-label \{[^}]*"opsz" 28;/);
    expect(css).toMatch(/\.type-number-small \{[^}]*"opsz" 28;/);
    expect(css).not.toMatch(/\.type-body \{[^}]*opsz/);
    expect(css).not.toMatch(/\.type-option \{[^}]*opsz/);
  });

  it('maps the spacing scale to Paper names (--spacing-<px/4>)', () => {
    expect(css).toContain('--spacing-4: 16px;');
    expect(css).toContain('--spacing-16: 64px;');
  });

  it('picks the breakpoint from the token widths', () => {
    expect(breakpointFor(380)).toBe('mobile');
    expect(breakpointFor(tokens.breakpoints.tablet)).toBe('tablet');
    expect(breakpointFor(tokens.breakpoints.desktop)).toBe('desktop');
  });
});
