import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/config';

/** The IEEE 754 double with these 64 bits (hex). */
function f64(bits: string): number {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, BigInt(`0x${bits}`));
  return v.getFloat64(0);
}

describe('RFC 8785 examples', () => {
  it('§3.2.2 sample (numbers, string escapes, literals)', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    ) as unknown;
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('§3.2.3 property sorting by UTF-16 code units', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",' +
        '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",' +
        '"😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it.each([
    ['0000000000000000', '0'],
    ['8000000000000000', '0'], // −0
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ])('Appendix B number %s → %s', (bits, text) => {
    expect(canonicalJson(f64(bits))).toBe(text);
  });

  it.each([
    [1e21, '1e+21'],
    [-0, '0'],
    [Number('333333333.33333329'), '333333333.3333333'],
    [4.5, '4.5'],
    [2e-3, '0.002'],
    [0.000001, '0.000001'],
    [1e-7, '1e-7'],
    [100, '100'],
  ])('number %d → %s', (n, text) => {
    expect(canonicalJson(n)).toBe(text);
  });
});

describe('structure', () => {
  it('sorts nested keys, keeps array order, has no whitespace', () => {
    expect(canonicalJson({ b: [3, { y: 1, x: 2 }], a: { d: null, c: 'é' } })).toBe(
      '{"a":{"c":"é","d":null},"b":[3,{"x":2,"y":1}]}',
    );
  });

  it('sorts integer-like keys as strings, not numerically', () => {
    expect(canonicalJson({ 9: 'a', 10: 'b', 1: 'c' })).toBe('{"1":"c","10":"b","9":"a"}');
  });

  it('escapes like JSON.stringify', () => {
    expect(canonicalJson('\u0000\u001f\u007f"\\/ ')).toBe('"\\u0000\\u001f\u007f\\"\\\\/ "');
  });

  it.each([
    ['undefined', undefined],
    ['undefined member', { a: undefined }],
    ['bigint', 1n],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['function', () => 1],
    ['symbol', Symbol('s')],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate key', { '\udc00': 1 }],
    ['sparse array', [1, , 3]], // eslint-disable-line no-sparse-arrays
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it('rejects cycles but allows shared references', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(TypeError);
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 1;
    o.a = 2;
    expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
  });
});

/** Rebuilds every object with its keys inserted in reverse order. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).reverse()) {
      Object.defineProperty(out, k, {
        value: reverseKeys((v as Record<string, unknown>)[k]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return v;
}

describe('properties', () => {
  const json = fc.jsonValue();

  it('parses back to the same JSON value', () => {
    fc.assert(
      fc.property(json, (x) => {
        expect(JSON.parse(canonicalJson(x))).toEqual(JSON.parse(JSON.stringify(x)));
      }),
    );
  });

  it('is idempotent and independent of key order', () => {
    fc.assert(
      fc.property(json, (x) => {
        const c = canonicalJson(x);
        expect(canonicalJson(JSON.parse(c))).toBe(c);
        expect(canonicalJson(reverseKeys(x))).toBe(c);
      }),
    );
  });
});
