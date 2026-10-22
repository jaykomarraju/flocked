// Turns a run of checks into the published verdict. The mapping is `@flocked/verify`'s, so the
// watcher and the `flocked-verify` CLI never disagree about the same evidence (W9-B): a failed
// check is a mismatch (exit 1); a check that could not run is `unable` (the library's
// `unverifiable`, exit 2); everything else is a match (exit 0).
import type { Check, Checks } from '@flocked/verify';
import type { VerdictValue } from './verdict.js';

/** One check as a reason line: short enough to page with, complete enough to act on. */
export function reasonOf(c: Check): string {
  const detail = c.detail ? `: ${c.detail}` : '';
  const values =
    c.expected !== undefined || c.actual !== undefined
      ? ` (published/expected ${c.expected ?? '—'}, onchain/actual ${c.actual ?? '—'})`
      : '';
  return `${c.status} ${c.id}${detail}${values}`.slice(0, 400);
}

export function decide(checks: Checks): { verdict: VerdictValue; reasons: string[] } {
  const list = checks.list;
  const verdict: VerdictValue = list.some((c) => c.status === 'fail')
    ? 'mismatch'
    : list.some((c) => c.status === 'error')
      ? 'unable'
      : 'match';
  return { verdict, reasons: list.map(reasonOf) };
}

/** `@flocked/verify`'s report verdict as a published one (`unverifiable` is `unable`). */
export function fromReportVerdict(v: 'match' | 'mismatch' | 'unverifiable'): VerdictValue {
  return v === 'unverifiable' ? 'unable' : v;
}
