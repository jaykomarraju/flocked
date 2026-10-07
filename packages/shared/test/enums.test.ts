import { describe, expect, it } from 'vitest';

import {
  CATEGORIES,
  isOneOf,
  MODE_STATUSES,
  MODES,
  NOTIFICATION_EVENTS,
  PROVIDERS,
  ROUND_KINDS,
  ROUND_STATUSES,
  TERMINAL_MODE_STATUSES,
  USER_STATUSES,
} from '../src/index';

// Values copied from Product_Spec.md. Changing one here needs a spec change first.
describe('enums match the spec', () => {
  it('Mode ("Modes: Free and Stakes")', () => {
    expect(MODES).toEqual(['free', 'stakes']);
  });

  it('RoundKind ("Data model": rounds.kind)', () => {
    expect(ROUND_KINDS).toEqual(['daily', 'room']);
  });

  it('RoundStatus ("Data model": Status enums)', () => {
    expect(ROUND_STATUSES).toEqual(['scheduled', 'open', 'closed']);
  });

  it('ModeStatus ("Data model": Status enums)', () => {
    expect(MODE_STATUSES).toEqual([
      'pending',
      'revealing',
      'settle_proposed',
      'refund_proposed',
      'settled',
      'refunded',
      'voided',
    ]);
    expect(TERMINAL_MODE_STATUSES).toEqual(['settled', 'refunded', 'voided']);
  });

  it('Category ("Core game rules": Question format)', () => {
    expect(CATEGORIES).toEqual(['food', 'life', 'tech', 'money', 'pop', 'hypothetical', 'other']);
  });

  it('Provider ("Data model": identities.provider)', () => {
    expect(PROVIDERS).toEqual(['farcaster', 'wallet', 'email', 'coinbase']);
  });

  it('UserStatus ("Data model": users.status)', () => {
    expect(USER_STATUSES).toEqual(['active', 'suspended', 'merged', 'deleted']);
  });

  it('NotificationEvent ("Notifications" table)', () => {
    expect(NOTIFICATION_EVENTS).toEqual([
      'question_live',
      'closing_soon',
      'outcome',
      'payout_claimable',
      'refunded',
      'question_used',
      'streak_at_risk',
      'question_edited',
      'security_notice',
    ]);
  });

  it('every list is unique and snake_case', () => {
    for (const list of [
      MODES,
      ROUND_KINDS,
      ROUND_STATUSES,
      MODE_STATUSES,
      CATEGORIES,
      PROVIDERS,
      USER_STATUSES,
      NOTIFICATION_EVENTS,
    ]) {
      expect(new Set(list).size).toBe(list.length);
      for (const v of list) expect(v).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('isOneOf', () => {
  it('narrows members and rejects everything else', () => {
    expect(isOneOf(MODES, 'stakes')).toBe(true);
    expect(isOneOf(MODES, 'Stakes')).toBe(false);
    expect(isOneOf(MODES, 1)).toBe(false);
    expect(isOneOf(MODES, undefined)).toBe(false);
  });
});
