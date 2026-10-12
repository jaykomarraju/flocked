import { describe, expect, it } from 'vitest';

import {
  EMAIL_CHROME,
  EMAIL_NEXT_LINK,
  fillCopy,
  isGameNotification,
  NOTIFICATION_COPY,
  NOTIFICATION_EVENT_CHANNELS,
  NOTIFICATION_PLACEHOLDERS,
  OUTCOME_NEXT_LIVE,
  PUSH_LIMITS,
  REFUND_LINES,
  type NotificationValues,
  type PushCopy,
} from '../src/copy/notifications';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  REFUND_REASON_CODES,
  SECURITY_NOTICE_KINDS,
  VOICE,
} from '../src/index';

/** Every string in a value, depth first. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(strings);
}

const QUESTION_120 = 'Q'.repeat(119) + '?';

/** The longest value each placeholder can take; `refundLine` is varied separately. */
const WORST: NotificationValues = {
  amount: '+1,234,567.89 USDC',
  payout: '1,234,567.89 USDC',
  share: '>99%',
  question: QUESTION_120,
  streak: '1000',
  mode: 'Stakes',
};

describe('notification copy (spec "Notifications")', () => {
  it('sends each event on exactly the channels in the spec table', () => {
    expect(NOTIFICATION_EVENT_CHANNELS).toEqual({
      question_live: ['farcaster', 'webpush'],
      closing_soon: ['farcaster', 'webpush'],
      outcome: ['farcaster', 'webpush', 'email'],
      payout_claimable: ['webpush', 'email'],
      refunded: ['farcaster', 'webpush', 'email'],
      question_used: ['farcaster', 'webpush'],
      streak_at_risk: ['farcaster', 'webpush'],
      question_edited: ['farcaster', 'webpush'],
      security_notice: ['farcaster', 'webpush', 'email'],
    });
  });

  it('has copy for every event × channel it is sent on, and is marked not sent on the others', () => {
    expect(Object.keys(NOTIFICATION_COPY)).toEqual([...NOTIFICATION_EVENTS]);
    for (const event of NOTIFICATION_EVENTS) {
      const sent: readonly string[] = NOTIFICATION_EVENT_CHANNELS[event];
      expect(Object.keys(NOTIFICATION_COPY[event]).sort()).toEqual(
        [...NOTIFICATION_CHANNELS].sort(),
      );
      for (const channel of NOTIFICATION_CHANNELS) {
        const copy = NOTIFICATION_COPY[event][channel];
        if (sent.includes(channel)) expect(copy, `${event}/${channel}`).not.toBeNull();
        else expect(copy, `${event}/${channel}`).toBeNull();
      }
    }
  });

  it('covers every variant of each event on each channel it is sent on', () => {
    const variants: Record<string, string[]> = {
      question_live: ['default'],
      closing_soon: ['default'],
      outcome: ['win', 'win_no_amount', 'loss', 'refund', 'void'],
      payout_claimable: ['default'],
      refunded: ['free', 'stakes'],
      question_used: ['scheduled', 'settled'],
      streak_at_risk: ['default'],
      question_edited: ['default'],
      security_notice: [...SECURITY_NOTICE_KINDS],
    };
    for (const event of NOTIFICATION_EVENTS) {
      for (const channel of NOTIFICATION_EVENT_CHANNELS[event]) {
        const copy = NOTIFICATION_COPY[event][channel] ?? {};
        expect(Object.keys(copy).sort(), `${event}/${channel}`).toEqual(
          [...(variants[event] ?? [])].sort(),
        );
      }
    }
  });

  it('never uses an exclamation point', () => {
    const all = strings({
      NOTIFICATION_COPY,
      REFUND_LINES,
      OUTCOME_NEXT_LIVE,
      EMAIL_NEXT_LINK,
      EMAIL_CHROME,
    });
    expect(all.length).toBeGreaterThan(100);
    for (const line of all) expect(line, line).not.toContain('!');
  });

  it('uses only known placeholders, and every line fills', () => {
    for (const line of strings(NOTIFICATION_COPY)) {
      for (const [, name] of line.matchAll(/\{(\w+)\}/g)) {
        expect(NOTIFICATION_PLACEHOLDERS, line).toContain(name);
      }
      expect(fillCopy(line, { ...WORST, refundLine: REFUND_LINES[1] })).not.toMatch(/[{}]/);
    }
  });

  it('fits the Farcaster limits with worst-case values, the outcome suffix and every refund line', () => {
    for (const event of NOTIFICATION_EVENTS) {
      for (const channel of ['farcaster', 'webpush'] as const) {
        const byVariant = NOTIFICATION_COPY[event][channel];
        if (byVariant === null) continue;
        for (const [variant, copy] of Object.entries<PushCopy>(byVariant)) {
          for (const refundLine of Object.values(REFUND_LINES)) {
            const values = { ...WORST, refundLine };
            const title = fillCopy(copy.title, values);
            const body =
              fillCopy(copy.body, values) + (event === 'outcome' ? ` ${OUTCOME_NEXT_LIVE}` : '');
            const where = `${event}/${channel}/${variant}`;
            expect(title.length, `${where} title: ${title}`).toBeLessThanOrEqual(PUSH_LIMITS.title);
            expect(body.length, `${where} body: ${body}`).toBeLessThanOrEqual(PUSH_LIMITS.body);
          }
        }
      }
    }
  });

  it('has one refund line per refund code, as written in Design_Language.md', () => {
    expect(Object.keys(REFUND_LINES).map(Number)).toEqual([...REFUND_REASON_CODES]);
    expect(REFUND_LINES[3]).toBe(VOICE.refundedTie);
    expect(REFUND_LINES[4]).toBe(
      'This round was called off before it closed. Everyone gets their stake back.',
    );
    expect(REFUND_LINES[7]).toBe(
      "The picks weren't locked in on time, so this round doesn't count. Points returned.",
    );
    expect(REFUND_LINES[8]).toBe(
      'The timelock never opened, so the picks stay sealed. Points returned.',
    );
  });

  it('treats only security notices as non-game notifications (self-exclusion)', () => {
    expect(NOTIFICATION_EVENTS.filter((e) => !isGameNotification(e))).toEqual(['security_notice']);
  });

  it('fillCopy rejects unknown placeholders and missing values', () => {
    expect(fillCopy('Unflocked {amount}', { amount: '+86 pts' })).toBe('Unflocked +86 pts');
    expect(() => fillCopy('{nope}', {})).toThrow(RangeError);
    expect(() => fillCopy('{share} thought the same thing you did.', {})).toThrow(RangeError);
  });
});
