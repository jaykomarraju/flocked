// New York schedule math. Spec: "Round lifecycle" › Timing and Scheduling: a daily round opens at 21:00
// America/New_York and closes at 21:00 New York time the next day (23 or 25 hours on DST change days); all
// times are computed from New York wall time; beacon-math times are Unix seconds.
//
// A game day is the New York calendar date (YYYY-MM-DD) on which the round closes. Uses only
// Intl.DateTimeFormat, so it runs unchanged in Node, browsers and Workers.

/** The schedule's time zone. */
export const SCHEDULE_TIME_ZONE = 'America/New_York';

/** Daily open and close wall time in New York (hour, 24-hour clock). */
export const DAILY_CLOSE_HOUR = 21;

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHEDULE_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const GAME_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function nyWall(unixSeconds: number): Wall {
  const p: Record<string, number> = {};
  for (const { type, value } of NY.formatToParts(new Date(unixSeconds * 1000))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return {
    y: p.year ?? 0,
    mo: p.month ?? 0,
    d: p.day ?? 0,
    h: p.hour ?? 0,
    mi: p.minute ?? 0,
    s: p.second ?? 0,
  };
}

function wallAsUtc(w: Wall): number {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) / 1000;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function formatDay(y: number, mo: number, d: number): string {
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
}

function parseGameDay(gameDay: string): { y: number; mo: number; d: number } {
  if (!isGameDay(gameDay))
    throw new RangeError(`not a game day (YYYY-MM-DD): ${JSON.stringify(gameDay)}`);
  const [y, mo, d] = gameDay.split('-').map(Number) as [number, number, number];
  return { y, mo, d };
}

function assertUnixSeconds(name: string, t: number): void {
  if (!Number.isSafeInteger(t) || t < 0) throw new RangeError(`${name} must be Unix seconds`);
}

/** True for a real calendar date written YYYY-MM-DD (years 1970–9999). */
export function isGameDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = GAME_DAY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** The game day `n` calendar days after `gameDay` (negative `n` goes back). */
export function addGameDays(gameDay: string, n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError('n must be an integer');
  const { y, mo, d } = parseGameDay(gameDay);
  const t = new Date(Date.UTC(y, mo - 1, d) + n * DAY_MS);
  return formatDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * Unix seconds of a New York wall time. Throws if the result does not read back as that wall time (a
 * spring-forward gap). Only called for 21:00, which is never in a DST gap or overlap.
 */
function nyToUnix(y: number, mo: number, d: number, h: number, mi = 0, s = 0): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
  // offset(t) = New York wall time at t, read as UTC, minus t (−5 h or −4 h). Two passes settle it.
  const off1 = wallAsUtc(nyWall(asUtc)) - asUtc;
  let t = asUtc - off1;
  const off2 = wallAsUtc(nyWall(t)) - t;
  if (off2 !== off1) t = asUtc - off2;
  const w = nyWall(t);
  if (w.y !== y || w.mo !== mo || w.d !== d || w.h !== h || w.mi !== mi || w.s !== s) {
    throw new RangeError(`${formatDay(y, mo, d)} ${pad(h)}:${pad(mi)} does not exist in New York`);
  }
  return t;
}

/** Unix seconds of 21:00 America/New_York on `gameDay`: when that day's daily round closes. */
export function dailyClosesAt(gameDay: string): number {
  const { y, mo, d } = parseGameDay(gameDay);
  return nyToUnix(y, mo, d, DAILY_CLOSE_HOUR);
}

/** Unix seconds when the daily round for `gameDay` opens: 21:00 New York the day before. */
export function dailyOpensAt(gameDay: string): number {
  return dailyClosesAt(addGameDays(gameDay, -1));
}

/** The New York date (YYYY-MM-DD) of the instant `closesAt` (Unix seconds): the round's game day. */
export function gameDayOf(closesAt: number): string {
  assertUnixSeconds('closesAt', closesAt);
  const w = nyWall(closesAt);
  return formatDay(w.y, w.mo, w.d);
}

/**
 * The game day whose daily round is open at `now` (Unix seconds), that is
 * `dailyOpensAt(day) ≤ now < dailyClosesAt(day)`. Entries are accepted only before `closesAt`.
 */
export function openGameDayAt(now: number): string {
  assertUnixSeconds('now', now);
  const today = gameDayOf(now);
  return now < dailyClosesAt(today) ? today : addGameDays(today, 1);
}

/**
 * ISO 8601 week (`YYYY-Www`, Monday to Sunday) containing `gameDay`. Weekly boards use it.
 * Spec: "Profiles, leaderboards and rooms".
 */
export function isoWeekOf(gameDay: string): string {
  const { y, mo, d } = parseGameDay(gameDay);
  const date = Date.UTC(y, mo - 1, d);
  const weekday = (new Date(date).getUTCDay() + 6) % 7; // Monday = 0
  // The Thursday of this week decides the ISO year.
  const thursday = new Date(date + (3 - weekday) * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${pad(isoYear, 4)}-W${pad(week)}`;
}
