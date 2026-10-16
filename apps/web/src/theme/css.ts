// The theme as CSS, generated from design-tokens.json (wave-8.md "Pinned interfaces": no retyped
// values). Custom properties follow the Paper file's token names (docs/design/README.md "Tokens in
// Paper"): `--color-*`, `--font-*`, `--text-*`, `--spacing-*`, `--radius-*`, plus `--border-*` and
// `--motion-*`. Dark mode swaps the same `--color-*` values under `prefers-color-scheme: dark`, or
// under `data-theme="dark"` on any element (the design sheets render light and dark side by side).
import type { DesignTokens } from '@flocked/shared';
import type { FontFile } from './fonts';

type Scheme = DesignTokens['color']['light'];
type Role = DesignTokens['type'][string];

/** camelCase → kebab-case: `accentInk` → `accent-ink`, `numberXL` → `number-xl`. */
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** The CSS font-family stack of a token font role. */
export function fontStack(tokens: DesignTokens, font: Role['font'] | 'mono'): string {
  if (font === 'mono') return tokens.font.mono.stack.join(', ');
  const family = font === 'numeric' ? tokens.font.numeric.family : tokens.font[font].family;
  const fallback =
    font === 'display' ? 'ui-rounded, system-ui, sans-serif' : 'system-ui, sans-serif';
  return `"${family}", ${fallback}`;
}

function colorVars(scheme: Scheme): string {
  return Object.entries(scheme)
    .map(([name, value]) => `--color-${kebab(name)}: ${value};`)
    .join(' ');
}

function fontFaces(tokens: DesignTokens, files: Record<'display' | 'body', FontFile[]>): string {
  return (['display', 'body'] as const)
    .flatMap((role) =>
      files[role].map(
        (f) =>
          `@font-face { font-family: "${tokens.font[role].family}"; font-style: normal; ` +
          `font-display: block; font-weight: ${f.weight[0]} ${f.weight[1]}; ` +
          `src: url("${f.url}") format("woff2"); unicode-range: ${f.unicodeRange}; }`,
      ),
    )
    .join('\n');
}

/** `.type-<role>`: one class per type role (font, size, line height, weight, tracking in em). */
function typeClasses(tokens: DesignTokens): string {
  return Object.entries(tokens.type)
    .map(([name, role]) => {
      const numeric =
        role.font === 'numeric'
          ? ` font-feature-settings: ${tokens.font.numeric.features.map((f) => `"${f}"`).join(', ')};`
          : '';
      return (
        `.type-${kebab(name)} { font-family: var(--font-${role.font}); ` +
        `font-size: var(--text-${kebab(name)}); line-height: ${role.lineHeight}px; ` +
        `font-weight: ${role.weight}; letter-spacing: ${role.tracking}em;${numeric} }`
      );
    })
    .join('\n');
}

export function themeCss(
  tokens: DesignTokens,
  files: Record<'display' | 'body', FontFile[]>,
): string {
  const { light, dark } = tokens.color;
  const root = [
    colorVars(light),
    'color-scheme: light;',
    `--font-display: ${fontStack(tokens, 'display')};`,
    `--font-body: ${fontStack(tokens, 'body')};`,
    `--font-numeric: ${fontStack(tokens, 'numeric')};`,
    `--font-mono: ${fontStack(tokens, 'mono')};`,
    ...Object.entries(tokens.type).map(([n, r]) => `--text-${kebab(n)}: ${r.size}px;`),
    ...tokens.space.filter((s) => s > 0).map((s) => `--spacing-${s / 4}: ${s}px;`),
    `--radius-card: ${tokens.radius.card}px;`,
    `--radius-pill: ${tokens.radius.pill}px;`,
    `--border-strong: ${tokens.border.strong}px;`,
    `--border-default: ${tokens.border.default}px;`,
    ...Object.entries(tokens.motion).flatMap(([n, m]) => [
      `--motion-${kebab(n)}-duration: ${m.durationMs}ms;`,
      `--motion-${kebab(n)}-easing: ${m.easing};`,
    ]),
  ].join(' ');
  const darkVars = `${colorVars(dark)} color-scheme: dark;`;
  return [
    fontFaces(tokens, files),
    `:root { ${root} }`,
    `[data-theme="light"] { ${colorVars(light)} color-scheme: light; }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${darkVars} } }`,
    `[data-theme="dark"] { ${darkVars} }`,
    typeClasses(tokens),
    // Tabular figures for any number (Design_Language.md "Typography").
    `.tnum { font-feature-settings: ${tokens.font.numeric.features.map((f) => `"${f}"`).join(', ')}; }`,
    // The foundation focus ring (docs/design/README.md "Focus"): 2px ink outline, 3px offset, on
    // focus-visible only.
    `:focus-visible { outline: var(--border-strong) solid var(--color-ink); outline-offset: 3px; }`,
    `:focus:not(:focus-visible) { outline: none; }`,
    // Reduced motion skips to the final state (Design_Language.md "Motion").
    `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; } }`,
  ].join('\n');
}
