import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { closestMatches, extractSection, extractSub, listHeadings, main } from './spec-section.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/spec-fixture.md');
const SCRIPT = resolve(here, 'spec-section.mjs');
const md = readFileSync(FIXTURE, 'utf8');

function run(args) {
  const out = [];
  const err = [];
  const code = main(
    ['--file', FIXTURE, ...args],
    (s) => out.push(s),
    (s) => err.push(s),
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('listHeadings', () => {
  it('lists every ## heading and skips code fences', () => {
    assert.deepEqual(listHeadings(md), ['Alpha', 'Beta: `code` heading', 'Gamma']);
  });
});

describe('extractSection', () => {
  it('returns the section up to the next ## heading, keeping ### subsections', () => {
    const s = extractSection(md, 'Alpha');
    assert.ok(s.startsWith('## Alpha\n'));
    assert.ok(s.includes('### Alpha subheading'));
    assert.ok(s.includes('Sub body.'));
    assert.ok(!s.includes('Beta'));
  });

  it('matches case-insensitively, ignoring backticks and a leading ##', () => {
    assert.ok(extractSection(md, '## beta: code heading')?.startsWith('## Beta'));
  });

  it('drops a trailing rule and blank lines', () => {
    assert.ok(extractSection(md, 'Beta: code heading').endsWith('Last block.'));
  });

  it('returns the last section to end of file', () => {
    assert.equal(extractSection(md, 'Gamma'), '## Gamma\n\nGamma body.');
  });

  it('returns null for an unknown heading', () => {
    assert.equal(extractSection(md, 'Delta'), null);
  });
});

describe('extractSub', () => {
  const alpha = extractSection(md, 'Alpha');
  const beta = extractSection(md, 'Beta: code heading');

  it('returns a paragraph label up to the next paragraph label', () => {
    assert.equal(extractSub(alpha, 'First label'), '**First label**\n\n- one\n- two');
  });

  it('ignores labels inside code fences and stops at a heading', () => {
    const s = extractSub(alpha, 'second label');
    assert.ok(s.includes('Still second.'));
    assert.ok(s.includes('**Not a label**'));
    assert.ok(!s.includes('Alpha subheading'));
  });

  it('returns a list-item label up to its next sibling', () => {
    assert.equal(extractSub(beta, 'Item one'), '- **Item one** text of item one.\n  - nested line');
  });

  it('ends the last list item at the next paragraph label', () => {
    assert.equal(extractSub(beta, 'Item two'), '- **Item two** text of item two.');
  });

  it('returns null for an unknown label', () => {
    assert.equal(extractSub(alpha, 'Nope'), null);
  });
});

describe('closestMatches', () => {
  it('ranks substring and near matches first', () => {
    assert.equal(closestMatches('alph', ['Gamma', 'Alpha', 'Beta'])[0], 'Alpha');
    assert.equal(closestMatches('Gamna', ['Alpha', 'Gamma', 'Beta'])[0], 'Gamma');
  });
});

describe('main', () => {
  it('prints a section', () => {
    const r = run(['Gamma']);
    assert.equal(r.code, 0);
    assert.equal(r.out, '## Gamma\n\nGamma body.');
  });

  it('prints a sub block', () => {
    const r = run(['Alpha', '--sub', 'First label']);
    assert.equal(r.code, 0);
    assert.equal(r.out, '**First label**\n\n- one\n- two');
  });

  it('lists headings', () => {
    assert.equal(run(['--list']).out, '## Alpha\n## Beta: `code` heading\n## Gamma');
  });

  it('exits 1 with suggestions for an unknown heading', () => {
    const r = run(['Gama']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Closest matches:\n {2}Gamma/);
  });

  it('exits 1 with suggestions for an unknown label', () => {
    const r = run(['Alpha', '--sub', 'Frist label']);
    assert.equal(r.code, 1);
    assert.match(r.err, /First label/);
  });

  it('exits 2 without a heading', () => {
    assert.equal(run([]).code, 2);
  });
});

describe('CLI', () => {
  it('reads Product_Spec.md from any cwd', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--list'], { cwd: '/', encoding: 'utf8' });
    assert.match(out, /^## Overview$/m);
  });

  it('sets exit code 1 for an unknown heading', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--file', FIXTURE, 'Nope'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Closest matches/);
  });
});
