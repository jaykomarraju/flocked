import type { Check, CheckStatus } from './types.js';

/** A value as report text: strings as they are, other values as JSON. */
function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? 'undefined';
}

/** How many failing items one aggregated check lists in its detail. */
const SHOWN = 5;

/** Collects checks. Per-entry checks are aggregated, so a large round still gives a short report. */
export class Checks {
  readonly list: Check[] = [];

  add(
    id: string,
    status: CheckStatus,
    detail?: string,
    expected?: unknown,
    actual?: unknown,
  ): void {
    const c: Check = { id, status };
    if (detail !== undefined) c.detail = detail;
    if (expected !== undefined) c.expected = text(expected);
    if (actual !== undefined) c.actual = text(actual);
    this.list.push(c);
  }

  pass(id: string, detail?: string): void {
    this.add(id, 'pass', detail);
  }

  fail(id: string, detail: string, expected?: unknown, actual?: unknown): void {
    this.add(id, 'fail', detail, expected, actual);
  }

  error(id: string, detail: string): void {
    this.add(id, 'error', detail);
  }

  skip(id: string, detail: string): void {
    this.add(id, 'skip', detail);
  }

  /** pass when `expected === actual` (as strings), else fail. */
  equal(id: string, what: string, expected: unknown, actual: unknown): boolean {
    if (text(expected) === text(actual)) {
      this.pass(id, what);
      return true;
    }
    this.fail(id, `${what} differs`, expected, actual);
    return false;
  }

  /** An aggregated check over many items: one pass, or one fail naming the first few bad items. */
  many(id: string, what: string): Aggregate {
    return new Aggregate(this, id, what);
  }

  failed(): boolean {
    return this.list.some((c) => c.status === 'fail');
  }

  has(id: string, status: CheckStatus): boolean {
    return this.list.some((c) => c.id === id && c.status === status);
  }
}

export class Aggregate {
  private readonly bad: string[] = [];
  private count = 0;

  constructor(
    private readonly checks: Checks,
    private readonly id: string,
    private readonly what: string,
  ) {}

  item(ok: boolean, describe: () => string): boolean {
    this.count += 1;
    if (!ok) this.bad.push(describe());
    return ok;
  }

  done(): void {
    if (this.bad.length === 0) {
      this.checks.pass(this.id, `${this.what} (${this.count})`);
      return;
    }
    const more = this.bad.length > SHOWN ? `; and ${this.bad.length - SHOWN} more` : '';
    this.checks.fail(
      this.id,
      `${this.bad.length} of ${this.count}: ${this.what}: ${this.bad.slice(0, SHOWN).join('; ')}${more}`,
    );
  }
}
