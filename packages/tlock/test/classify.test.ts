import type { VoidReason } from '@flocked/settle';
import { VOID_REASONS } from '@flocked/settle';
import { bls12_381 } from '@noble/curves/bls12-381';
import type { Stanza } from 'tlock-js/age/age-encrypt-decrypt.js';
import { decryptAge } from 'tlock-js/age/age-encrypt-decrypt.js';
import { decryptOnG2 } from 'tlock-js/crypto/ibe.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  QUICKNET,
  classify,
  encodePlaintext,
  encryptPick,
  isCanonicalHeader,
  roundRefFromChainId,
} from '../src/index.js';
import { bytesToLatin1, latin1ToBytes } from '../src/encoding.js';
import { sealBytes } from '../src/seal.js';
import {
  beacon,
  fixturePick,
  hex,
  joinCt,
  otherG2PublicKey,
  randomBytes,
  remac,
  splitCt,
  stanzaBody,
  withBody,
} from './helpers.js';

const ROUND = 1_000_000;
const { signature } = beacon(ROUND);
const roundRef = roundRefFromChainId(42n);
const nonce = randomBytes(16);
const OTHER_HASH = '8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce'; // drand default network

let valid: Uint8Array;
beforeAll(async () => {
  valid = await encryptPick(QUICKNET, ROUND, encodePlaintext({ roundRef, optionIndex: 1, nonce }));
});

async function reasonOf(
  ct: Uint8Array,
  beaconRound = ROUND,
  ref = roundRef,
): Promise<VoidReason | 'valid'> {
  const r = await classify({
    ct,
    chain: QUICKNET,
    beaconRound,
    signature: beacon(beaconRound).signature,
    roundRef: ref,
  });
  return r.valid ? 'valid' : r.voidReason;
}

/** Edits the header lines of the valid ciphertext; the payload is kept. */
function editLines(edit: (lines: string[]) => string[]): Uint8Array {
  const { lines, payload } = splitCt(valid);
  return joinCt(edit([...lines]), payload);
}

/** Edits the decoded stanza body of `ct` (by default the valid ciphertext) and re-wraps it canonically. */
function editBody(edit: (body: Uint8Array) => Uint8Array, ct = valid): Uint8Array {
  return withBody(ct, edit(stanzaBody(ct)));
}

const sealed = (pt: Uint8Array) => sealBytes(QUICKNET, ROUND, pt);
const withByte = (at: number, value: number) => {
  const pt = encodePlaintext({ roundRef, optionIndex: 0, nonce });
  pt[at] = value;
  return pt;
};

describe('TL-3: malformed ciphertexts and bad plaintexts are VOID with their exact reason', () => {
  it('the untouched ciphertext is valid', async () => {
    expect(await reasonOf(valid)).toBe('valid');
    expect(isCanonicalHeader(valid, QUICKNET, ROUND)).toBe(true);
  });

  describe('non_canonical_header', () => {
    const cases: [string, () => Uint8Array][] = [
      ['empty', () => new Uint8Array(0)],
      ['random bytes', () => randomBytes(400)],
      [
        'armored',
        () =>
          latin1ToBytes(
            '-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n',
          ),
      ],
      ['header only, no MAC line', () => editLines((l) => l.slice(0, -1))],
      ['other version line', () => editLines((l) => ['age-encryption.org/v2', ...l.slice(1)])],
      [
        'extra tlock stanza',
        () => editLines((l) => [...l.slice(0, -1), ...l.slice(1, -1), l.at(-1) ?? '']),
      ],
      [
        'extra X25519 stanza',
        () => editLines((l) => [...l.slice(0, -1), '-> X25519 AAAA', 'BBBB', l.at(-1) ?? '']),
      ],
      [
        'stanza type other than tlock',
        () => editLines((l) => [l[0] ?? '', (l[1] ?? '').replace('tlock', 'Tlock'), ...l.slice(2)]),
      ],
      [
        'three stanza arguments',
        () => editLines((l) => [l[0] ?? '', `${l[1] ?? ''} extra`, ...l.slice(2)]),
      ],
      [
        'one stanza argument',
        () => editLines((l) => [l[0] ?? '', `-> tlock ${ROUND}`, ...l.slice(2)]),
      ],
      [
        'double space between arguments',
        () => editLines((l) => [l[0] ?? '', (l[1] ?? '').replace(' 5', '  5'), ...l.slice(2)]),
      ],
      [
        'round with a leading zero',
        () =>
          editLines((l) => [
            l[0] ?? '',
            (l[1] ?? '').replace(`${ROUND}`, `0${ROUND}`),
            ...l.slice(2),
          ]),
      ],
      [
        'round with a plus sign',
        () =>
          editLines((l) => [
            l[0] ?? '',
            (l[1] ?? '').replace(`${ROUND}`, `+${ROUND}`),
            ...l.slice(2),
          ]),
      ],
      [
        'uppercase chain hash',
        () =>
          editLines((l) => [
            l[0] ?? '',
            (l[1] ?? '').toUpperCase().replace('-> TLOCK', '-> tlock'),
            ...l.slice(2),
          ]),
      ],
      [
        'short chain hash',
        () => editLines((l) => [l[0] ?? '', (l[1] ?? '').slice(0, -2), ...l.slice(2)]),
      ],
      [
        'body wrapped at 60 columns',
        () =>
          editLines((l) => [
            l[0] ?? '',
            l[1] ?? '',
            ...(l
              .slice(2, -1)
              .join('')
              .match(/.{1,60}/g) ?? []),
            l.at(-1) ?? '',
          ]),
      ],
      [
        'body with padding',
        () => editLines((l) => [...l.slice(0, -2), `${l.at(-2) ?? ''}=`, l.at(-1) ?? '']),
      ],
      [
        'body with non-canonical trailing bits',
        () =>
          editLines((l) => {
            // 128 bytes are 171 base64 chars; the last char's two low bits are unused and must be zero.
            const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
            const last = l.at(-2) ?? '';
            const flipped = last.slice(0, -1) + (B64[B64.indexOf(last.at(-1) ?? 'A') ^ 1] ?? '');
            return [...l.slice(0, -2), flipped, l.at(-1) ?? ''];
          }),
      ],
      [
        'CRLF line endings',
        () => editLines((l) => l.map((x, k) => (k < l.length - 1 ? `${x}\r` : x))),
      ],
      [
        'MAC of the wrong length',
        () => editLines((l) => [...l.slice(0, -1), `${l.at(-1) ?? ''}AAAA`]),
      ],
      [
        'MAC line without a space',
        () => editLines((l) => [...l.slice(0, -1), (l.at(-1) ?? '').replace('--- ', '---')]),
      ],
    ];
    it.each(cases)('%s', async (_name, make) => {
      const ct = make();
      expect(await reasonOf(ct)).toBe('non_canonical_header');
      expect(isCanonicalHeader(ct, QUICKNET, ROUND)).toBe(false);
    });
  });

  describe('wrong_target', () => {
    it('encrypted to another round', async () => {
      const ct = await encryptPick(
        QUICKNET,
        1_000_000 + 1,
        encodePlaintext({ roundRef, optionIndex: 0, nonce }),
      );
      expect(await reasonOf(ct)).toBe('wrong_target');
      expect(isCanonicalHeader(ct, QUICKNET, ROUND)).toBe(false);
    });
    it('encrypted to a round we have a beacon for, but not the round being settled', async () => {
      const ct = await encryptPick(
        QUICKNET,
        12_345_678,
        encodePlaintext({ roundRef, optionIndex: 0, nonce }),
      );
      expect(await reasonOf(ct)).toBe('wrong_target');
    });
    it('right round, another chain hash (wave-2 open question: wrong_target)', async () => {
      const ct = editLines((l) => [l[0] ?? '', `-> tlock ${ROUND} ${OTHER_HASH}`, ...l.slice(2)]);
      expect(await reasonOf(ct)).toBe('wrong_target');
      const other = await encryptPick(
        { ...QUICKNET, chainHash: OTHER_HASH },
        ROUND,
        encodePlaintext({ roundRef, optionIndex: 0, nonce }),
      );
      expect(await reasonOf(other)).toBe('wrong_target');
    });
    it('round 0 in canonical decimal', async () => {
      const ct = editLines((l) => [
        l[0] ?? '',
        (l[1] ?? '').replace(`${ROUND}`, '0'),
        ...l.slice(2),
      ]);
      expect(await reasonOf(ct)).toBe('wrong_target');
    });
  });

  describe('decrypt_failed', () => {
    const flip = (at: number) => (b: Uint8Array) => {
      b[at] = (b[at] ?? 0) ^ 0x01;
      return b;
    };
    const cases: [string, () => Promise<Uint8Array> | Uint8Array][] = [
      [
        'a flipped payload byte',
        () => {
          const { lines, payload } = splitCt(valid);
          return joinCt(lines, flip(30)(payload));
        },
      ],
      [
        'a flipped payload nonce byte',
        () => {
          const { lines, payload } = splitCt(valid);
          return joinCt(lines, flip(0)(payload));
        },
      ],
      [
        'truncated payload',
        () => {
          const { lines, payload } = splitCt(valid);
          return joinCt(lines, payload.slice(0, -1));
        },
      ],
      [
        'payload is only the nonce',
        () => {
          const { lines, payload } = splitCt(valid);
          return joinCt(lines, payload.slice(0, 16));
        },
      ],
      [
        'no payload',
        () => {
          const { lines } = splitCt(valid);
          return joinCt(lines, new Uint8Array(0));
        },
      ],
      [
        'trailing bytes after the payload',
        () => {
          const { lines, payload } = splitCt(valid);
          return joinCt(lines, new Uint8Array([...payload, 0]));
        },
      ],
      ['a flipped bit in V', () => editBody(flip(100))],
      ['a flipped bit in W', () => editBody(flip(120))],
      ['U is not a curve point', () => editBody(flip(50))],
      [
        'U without the compression flag',
        () =>
          editBody((b) => {
            b[0] = (b[0] ?? 0) & 0x7f;
            return b;
          }),
      ],
      [
        'U flagged as infinity with a non-zero x',
        () =>
          editBody((b) => {
            b[0] = (b[0] ?? 0) | 0x40;
            b[0] &= 0xdf; // compressed + infinity + sort is itself an invalid flag combination
            return b;
          }),
      ],
      [
        'U with its sort flag flipped (the canonical encoding of −U)',
        () =>
          editBody((b) => {
            b[0] = (b[0] ?? 0) ^ 0x20;
            return b;
          }),
      ],
      ['stanza body one byte short', () => editBody((b) => b.slice(0, -1))],
      ['stanza body one byte long', () => editBody((b) => new Uint8Array([...b, 0]))],
      ['a wrong header MAC', () => editLines((l) => [...l.slice(0, -1), `--- ${'A'.repeat(42)}E`])],
      [
        'MAC from another ciphertext',
        async () => {
          const other = await encryptPick(
            QUICKNET,
            ROUND,
            encodePlaintext({ roundRef, optionIndex: 1, nonce }),
          );
          return editLines((l) => [...l.slice(0, -1), splitCt(other).lines.at(-1) ?? '']);
        },
      ],
      [
        'payload from another ciphertext',
        async () => {
          const other = await encryptPick(
            QUICKNET,
            ROUND,
            encodePlaintext({ roundRef, optionIndex: 1, nonce }),
          );
          return joinCt(splitCt(valid).lines, splitCt(other).payload);
        },
      ],
      // tlock-js seals an empty plaintext as a nonce with no STREAM chunk, which is not a valid age payload.
      ['tlock-js output for an empty plaintext', () => sealed(new Uint8Array(0))],
      [
        'encrypted to a key impersonating quicknet',
        () =>
          encryptPick(
            { ...QUICKNET, publicKey: otherG2PublicKey() },
            ROUND,
            encodePlaintext({ roundRef, optionIndex: 1, nonce }),
          ),
      ],
    ];
    it.each(cases)('%s', async (_name, make) => {
      expect(await reasonOf(await make())).toBe('decrypt_failed');
    });
  });

  describe('decrypt_failed: U must be the canonical compressed encoding of a G2 point', () => {
    const G2 = bls12_381.G2.ProjectivePoint;
    const P = bls12_381.fields.Fp.ORDER;
    // A committed pick whose x_c1 is below 2^381 − p, so x_c1 + p still fits under the three flag bits.
    const PICK_ROUND = 32_870_075;
    const pick = fixturePick(PICK_ROUND);
    const sig = hex(pick.signature);
    const U = stanzaBody(pick.ct).subarray(0, 96);
    const split = (body: Uint8Array) => ({
      U: body.subarray(0, 96),
      V: body.subarray(96, 112),
      W: body.subarray(112),
    });
    let fileKey: Uint8Array;
    beforeAll(async () => {
      fileKey = await decryptOnG2(sig, split(stanzaBody(pick.ct)));
    });

    const num = (b: Uint8Array) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
    const be48 = (n: bigint) =>
      Uint8Array.from({ length: 48 }, (_, k) => Number((n >> BigInt(8 * (47 - k))) & 0xffn));
    /** x = x_c0 + x_c1·u: bytes 0..47 are x_c1 under the 3 flag bits, bytes 48..95 are x_c0. */
    const x1 = (u: Uint8Array) => num(Uint8Array.from([(u[0] ?? 0) & 0x1f, ...u.subarray(1, 48)]));
    const x0 = (u: Uint8Array) => num(u.subarray(48, 96));
    const withX0 = (u: Uint8Array, x: bigint) => {
      const out = u.slice();
      out.set(be48(x), 48);
      return out;
    };
    const withX1 = (u: Uint8Array, x: bigint) => {
      if (x >= 2n ** 381n) throw new Error('x_c1 does not fit under the flag bits');
      const out = u.slice();
      out.set(be48(x), 0);
      out[0] = (out[0] ?? 0) | ((u[0] ?? 0) & 0xe0);
      return out;
    };

    /** The pick with U replaced and the header MAC re-signed under its file key, as its author could. */
    const forge = (u: Uint8Array) =>
      remac(
        editBody((b) => {
          b.set(u, 0);
          return b;
        }, pick.ct),
        fileKey,
      );
    /** What `openParsed` did before it checked U: tlock-js's age layer and `decryptOnG2` alone. */
    const openWithTlockJs = async (ct: Uint8Array) =>
      Uint8Array.from(
        await decryptAge(bytesToLatin1(ct), ([s]: Stanza[]) =>
          decryptOnG2(sig, split(s?.body ?? new Uint8Array(0))),
        ),
      );
    const reason = (ct: Uint8Array) => reasonOf(ct, PICK_ROUND, pick.roundRef);

    it('the committed pick is valid, and re-signing its own header reproduces its MAC', async () => {
      expect(await reason(pick.ct)).toBe('valid');
      expect(remac(pick.ct, fileKey)).toEqual(pick.ct);
      expect(forge(U)).toEqual(pick.ct);
    });

    it.each([
      ['x_c0 + p', (u: Uint8Array) => withX0(u, x0(u) + P)],
      ['x_c0 + 2p', (u: Uint8Array) => withX0(u, x0(u) + 2n * P)],
      ['x_c1 + p, flag bits kept', (u: Uint8Array) => withX1(u, x1(u) + P)],
    ])('%s: noble and tlock-js accept it, classify says decrypt_failed', async (_name, make) => {
      const u = make(U);
      expect(u).not.toEqual(U);
      // Without the canonical check this ciphertext is a valid pick: noble reduces the coordinate mod p
      // and decodes the same point, and tlock-js alone opens the re-signed ciphertext to the pick.
      expect(G2.fromHex(u).equals(G2.fromHex(U))).toBe(true);
      const forged = forge(u);
      expect(await openWithTlockJs(forged)).toEqual(pick.plaintext);
      expect(await reason(forged)).toBe('decrypt_failed');
    });

    it('U = compressed infinity (0xc0, then zeros): a canonical encoding, still decrypt_failed', async () => {
      const inf = new Uint8Array(96);
      inf[0] = 0xc0;
      expect(G2.fromHex(inf).equals(G2.ZERO)).toBe(true);
      expect(G2.ZERO.toRawBytes(true)).toEqual(inf);
      expect(await reason(forge(inf))).toBe('decrypt_failed');
    });
  });

  describe('bad_plaintext', () => {
    const cases: [string, () => Promise<Uint8Array>][] = [
      ['33 bytes', () => sealed(withByte(0, 1).slice(0, 33))],
      ['35 bytes', () => sealed(new Uint8Array([...withByte(0, 1), 0]))],
      ['1 byte', () => sealed(new Uint8Array([1]))],
      ['version 0x00', () => sealed(withByte(0, 0))],
      ['version 0x02', () => sealed(withByte(0, 2))],
      [
        'another round reference',
        () =>
          encryptPick(
            QUICKNET,
            ROUND,
            encodePlaintext({ roundRef: roundRefFromChainId(43n), optionIndex: 0, nonce }),
          ),
      ],
      ['a reference one bit off', () => sealed(withByte(16, (roundRef[15] ?? 0) ^ 1))],
      [
        'bad version beats a bad option',
        () =>
          sealed(
            (() => {
              const p = withByte(0, 2);
              p[17] = 7;
              return p;
            })(),
          ),
      ],
    ];
    it.each(cases)('%s', async (_name, make) => {
      expect(await reasonOf(await make())).toBe('bad_plaintext');
    });
  });

  describe('bad_option', () => {
    it.each([2, 3, 0x80, 0xff])('optionIndex %i', async (opt) => {
      expect(await reasonOf(await sealed(withByte(17, opt)))).toBe('bad_option');
    });
  });

  it("every reason classify can return is one of settle's VOID_REASONS", () => {
    for (const r of [
      'non_canonical_header',
      'wrong_target',
      'decrypt_failed',
      'bad_plaintext',
      'bad_option',
    ]) {
      expect(VOID_REASONS).toContain(r);
    }
  });

  it('a roundRef that is not 16 bytes is a caller error, not a VOID', async () => {
    await expect(
      classify({
        ct: valid,
        chain: QUICKNET,
        beaconRound: ROUND,
        signature,
        roundRef: new Uint8Array(15),
      }),
    ).rejects.toThrow(RangeError);
  });
});
