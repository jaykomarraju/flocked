// The two-phase rule as a config check (W8-C; W7-Z review): every Playwright test lands in exactly
// one project, warp phases hold only @warp tests, and each warp phase depends on the one non-warp
// phase sharing its stack (playwright.config.ts). Lists the tests with `playwright test --list`, so
// it needs no stack or browser. Run by `pnpm test` (node:test; Node strips the types).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import config from '../playwright.config.ts';

const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

interface ListedSpec {
  title: string;
  file: string;
  tags: string[];
  tests: { projectName: string }[];
}
interface ListedSuite {
  specs?: ListedSpec[];
  suites?: ListedSuite[];
}
interface Listing {
  suites: ListedSuite[];
}

function list(): Listing {
  const out = execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
    cwd: E2E_DIR,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out) as Listing;
}

function specs(suites: ListedSuite[]): ListedSpec[] {
  return suites.flatMap((s) => [...(s.specs ?? []), ...specs(s.suites ?? [])]);
}

const listing = list();
const all = specs(listing.suites);
// The JSON reporter drops a tag's `@`.
const isWarp = (spec: ListedSpec) => spec.tags.includes('warp') || /@warp\b/.test(spec.title);

void test('lists the api and ui specs', () => {
  assert.ok(all.some((s) => s.file.startsWith('lifecycle.spec')));
});

void test('every test runs in exactly one project', () => {
  const wrong = all
    .filter((s) => s.tests.length !== 1)
    .map(
      (s) => `${s.file} › ${s.title}: ${s.tests.map((t) => t.projectName).join(', ') || 'none'}`,
    );
  assert.deepEqual(wrong, []);
});

void test('warp phases hold exactly the @warp tests', () => {
  for (const spec of all) {
    const project = spec.tests[0]?.projectName ?? '';
    assert.equal(
      project.endsWith('-warp'),
      isWarp(spec),
      `${spec.file} › ${spec.title} in ${project}`,
    );
  }
});

void test('each warp phase depends only on the non-warp phase of its own suite', () => {
  const projects = config.projects ?? [];
  const warp = projects.filter((p) => p.name?.endsWith('-warp'));
  assert.deepEqual(warp.map((p) => p.name).sort(), ['api-warp', 'ui-warp']);
  for (const p of projects.filter((q) => !q.name?.endsWith('-warp'))) {
    assert.equal(p.dependencies, undefined, `${p.name} is a first phase`);
  }
  for (const p of warp) {
    const first = p.name?.replace(/-warp$/, '');
    assert.deepEqual(p.dependencies, [first], p.name);
    const base = projects.find((q) => q.name === first);
    assert.equal(base?.testDir, p.testDir, `${p.name} shares ${first}'s specs`);
    assert.ok(base?.grepInvert instanceof RegExp && base.grepInvert.test('@warp'), first);
    assert.ok(p.grep instanceof RegExp && p.grep.test('@warp'), p.name);
  }
});
