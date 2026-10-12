// The Stakes age requirement (spec "Compliance and responsible play" › Age and terms;
// src/personhood/age.ts requiredAge): 21 where `geo.stakes.age21` names the verified country (whole
// country only) or the request location (its country or its region), and, when the request has no
// region code, wherever an entry names a region of the request's country (O3, Oct 12, 2026).
import { describe, expect, it } from 'vitest';
import { requiredAge } from '../../src/personhood/age.js';
import type { GeoRule } from '../../src/personhood/config-store.js';

const rule = (code: string): GeoRule => {
  const [country = '', region = null] = code.split('-');
  return { country, region };
};
const at = (country: string | null, region: string | null = null) => ({ country, region });

describe('requiredAge', () => {
  it('a request with no region code needs 21 when an entry names a region of its country (O3)', () => {
    const age21 = [rule('US-NJ')];
    expect(requiredAge(age21, 'US', at('US'))).toBe(21);
    expect(requiredAge(age21, null, at('US'))).toBe(21);
    // Another country's region entries don't apply.
    expect(requiredAge([rule('CA-QC')], 'US', at('US'))).toBe(18);
    // With a region code, only that region's entry (or the whole country's) applies.
    expect(requiredAge(age21, 'US', at('US', 'NY'))).toBe(18);
    expect(requiredAge(age21, 'US', at('US', 'NJ'))).toBe(21);
  });

  it('whole-country entries name the request country and the verified country; region entries never the verified one', () => {
    expect(requiredAge([rule('CA')], 'CA', at('US', 'NJ'))).toBe(21);
    expect(requiredAge([rule('US')], 'CA', at('US', 'NJ'))).toBe(21);
    expect(requiredAge([rule('CA-QC')], 'CA', at('US', 'NJ'))).toBe(18);
    expect(requiredAge([], 'US', at('US'))).toBe(18);
    // No request location (Tor, unknown): only the verified country can require 21.
    expect(requiredAge([rule('US-NJ')], 'US', at(null))).toBe(18);
    expect(requiredAge([rule('US')], 'US', at(null))).toBe(21);
  });
});
