import { describe, expect, it } from 'vitest';

import { HandleSchema, RESERVED_HANDLES, isReservedHandle, reservedHandleForm } from '../src/index';

describe('reserved handles', () => {
  it('lists the spec examples, each in normal form', () => {
    for (const h of [
      'admin',
      'flocked',
      'support',
      'official',
      'mod',
      'guardian',
      'api',
      'help',
      'root',
      'system',
    ]) {
      expect(RESERVED_HANDLES).toContain(h);
    }
    for (const h of RESERVED_HANDLES) expect(reservedHandleForm(h)).toBe(h);
  });

  it('matches case-insensitively and ignores _ and -', () => {
    for (const h of ['admin', 'ADMIN', 'Admin', 'ad_min', 'ad-min', '_admin_', 'Flocked-', 'MOD']) {
      expect(isReservedHandle(h)).toBe(true);
    }
  });

  it('leaves ordinary handles alone, including ones that contain a reserved word', () => {
    for (const h of [
      'ewe_one',
      'admiral',
      'modern',
      'helpful',
      'flocker',
      'rooted',
      'sheep-mod2',
    ]) {
      expect(isReservedHandle(h)).toBe(false);
    }
  });

  it('every reserved word of handle length is a valid handle shape (so the check is reachable)', () => {
    for (const h of RESERVED_HANDLES.filter((x) => x.length >= 3 && x.length <= 20)) {
      expect(HandleSchema.safeParse(h).success).toBe(true);
    }
  });
});
