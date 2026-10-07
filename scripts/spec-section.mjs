#!/usr/bin/env node
// Prints one `## ` section of Product_Spec.md, or one bold-labelled block inside it.
//
//   pnpm spec "<heading>"                  the whole `## <heading>` section
//   pnpm spec "<heading>" --sub "<label>"  the `**<label>**` block within it
//   pnpm spec --list                       every `## ` heading
//
// Options: --file <path> reads another markdown file (used by tests).
// Exit codes: 0 found, 1 not found (closest matches go to stderr), 2 usage error.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SPEC = resolve(ROOT, 'Product_Spec.md');

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6} /;
const BOLD_LABEL = /^(\s*)(?:[-*+] |\d+\. )?\*\*(.+?)\*\*/;

/** Normalises a heading or label for comparison: no markdown punctuation, no case. */
export function normalize(s) {
  return s
    .replace(/^#+\s*/, '')
    .replace(/[`*_\\]/g, '')
    .replace(/[:.]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Marks each line as inside a code fence (true) or not. */
function fenceMask(lines) {
  let inFence = false;
  return lines.map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return true;
    }
    return inFence;
  });
}

/** Returns every `## ` heading (text only), skipping code fences. */
export function listHeadings(markdown) {
  const lines = markdown.split('\n');
  const mask = fenceMask(lines);
  return lines.filter((l, i) => !mask[i] && l.startsWith('## ')).map((l) => l.slice(3).trim());
}

/** Returns the `## <heading>` section (heading line included) or null. */
export function extractSection(markdown, heading) {
  const want = normalize(heading);
  const lines = markdown.split('\n');
  const mask = fenceMask(lines);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i];
    if (start === -1) {
      if (line.startsWith('## ') && normalize(line.slice(3)) === want) start = i;
    } else if (/^#{1,2} /.test(line)) {
      return trimBlock(lines.slice(start, i));
    }
  }
  return start === -1 ? null : trimBlock(lines.slice(start));
}

/**
 * Returns the block starting at the bold label `**<label>**` inside `section`. A paragraph-level
 * label runs to the next paragraph-level label or heading; a list-item label (`- **x**`) runs to
 * its next sibling item, anything less indented, or a heading.
 */
export function extractSub(section, label) {
  const want = normalize(label);
  const lines = section.split('\n');
  const mask = fenceMask(lines);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i];
    if (start === -1) {
      const m = BOLD_LABEL.exec(line);
      if (m && normalize(m[2]) === want) {
        start = i;
        level = levelOf(line);
      }
      continue;
    }
    if (line.trim() === '') continue;
    const ends =
      HEADING.test(line) ||
      // A list item ends at its next sibling or anything less indented.
      (level > 0 && indentOf(line) <= level - 1) ||
      // A paragraph label ends at the next paragraph label.
      (level === 0 && BOLD_LABEL.test(line) && levelOf(line) === 0);
    if (ends) return trimBlock(lines.slice(start, i));
  }
  return start === -1 ? null : trimBlock(lines.slice(start));
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** 0 for a paragraph-level label, indent + 1 for a list-item label. */
function levelOf(line) {
  return /^\s*(?:[-*+] |\d+\. )/.test(line) ? indentOf(line) + 1 : 0;
}

/** Returns the bold labels in a section, for suggestions. */
export function listLabels(section) {
  const lines = section.split('\n');
  const mask = fenceMask(lines);
  return lines
    .filter((_, i) => !mask[i])
    .map((l) => BOLD_LABEL.exec(l))
    .filter((m) => m !== null)
    .map((m) => m[2].replace(/[`]/g, ''));
}

function trimBlock(lines) {
  let end = lines.length;
  while (end > 0 && (lines[end - 1].trim() === '' || lines[end - 1].trim() === '---')) end--;
  return lines.slice(0, end).join('\n');
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Ranks candidates by closeness to `query`: substring matches first, then edit distance. */
export function closestMatches(query, candidates, limit = 5) {
  const q = normalize(query);
  const words = q.split(' ').filter(Boolean);
  return candidates
    .map((c) => {
      const n = normalize(c);
      let score = levenshtein(q, n) / Math.max(q.length, n.length, 1);
      if (n.includes(q) || q.includes(n)) score -= 1;
      score -= 0.25 * words.filter((w) => n.includes(w)).length;
      return { c, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.c);
}

function parseArgs(argv) {
  const opts = { heading: null, sub: null, list: false, file: DEFAULT_SPEC };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--list') opts.list = true;
    else if (a === '--sub') opts.sub = argv[++i] ?? null;
    else if (a === '--file') opts.file = resolve(argv[++i] ?? '');
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (opts.heading === null) opts.heading = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return opts;
}

const USAGE = 'usage: pnpm spec "<heading>" [--sub "<bold label>"] | pnpm spec --list';

export function main(argv, out = console.log, err = console.error) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  const markdown = readFileSync(opts.file, 'utf8');
  const headings = listHeadings(markdown);
  if (opts.list) {
    out(headings.map((h) => `## ${h}`).join('\n'));
    return 0;
  }
  if (!opts.heading || (opts.sub !== null && opts.sub === '')) {
    err(USAGE);
    return 2;
  }
  const section = extractSection(markdown, opts.heading);
  if (section === null) {
    err(`No section "## ${opts.heading.replace(/^#+\s*/, '')}". Closest matches:`);
    for (const h of closestMatches(opts.heading, headings)) err(`  ${h}`);
    return 1;
  }
  if (opts.sub === null) {
    out(section);
    return 0;
  }
  const block = extractSub(section, opts.sub);
  if (block === null) {
    err(`No bold label "**${opts.sub}**" in "## ${opts.heading}". Closest matches:`);
    for (const l of closestMatches(opts.sub, listLabels(section))) err(`  ${l}`);
    return 1;
  }
  out(block);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
