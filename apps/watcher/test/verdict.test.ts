// The pinned verdict (wave-10.md "Pinned interfaces"): its schema, the exact bytes the signature
// covers, and that a verdict proves who signed it. W10-D copies src/verdict.ts into
// packages/shared/src/watcher.ts, so these are the guarantees that must survive the copy.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  VERDICT_SUBJECTS,
  VERDICT_VALUES,
  VerdictSchema,
  pages,
  signVerdict,
  verdictMessage,
  verifyVerdict,
  watcherAddress,
  watcherKey,
  type UnsignedVerdict,
} from '../src/verdict.js';

const unsigned: UnsignedVerdict = {
  subject: 'stakes_proposal',
  roundId: '01K8V3R4N5P6Q7S8T9VWXYZABC',
  mode: 'stakes',
  verdict: 'mismatch',
  reasons: ['fail payoutRoot: payout root differs'],
  checkedAt: 1_760_000_000_000,
};

describe('the published verdict', () => {
  it('is the pinned shape: subject, roundId, mode, verdict, reasons, checkedAt, signature', async () => {
    const key = generatePrivateKey();
    const v = await signVerdict(key, unsigned);
    expect(Object.keys(v).sort()).toEqual(
      ['checkedAt', 'mode', 'reasons', 'roundId', 'signature', 'subject', 'verdict'].sort(),
    );
    expect(VerdictSchema.parse(v)).toEqual(v);
    expect(VERDICT_VALUES).toEqual(['match', 'mismatch', 'unable']);
    expect([...VERDICT_SUBJECTS]).toEqual(['stakes_round', 'stakes_proposal', 'stakes_refund']);
  });

  it('is signed EIP-191 by WATCHER_KEY, and the signature names the signer', async () => {
    const key = generatePrivateKey();
    const v = await signVerdict(key, unsigned);
    const address = watcherAddress(key);
    expect(address).toBe(privateKeyToAccount(key).address);
    await expect(verifyVerdict(v, address)).resolves.toBe(true);
    await expect(verifyVerdict(v, watcherAddress(generatePrivateKey()))).resolves.toBe(false);
  });

  it('covers every field, so no part of a verdict can be changed after signing', async () => {
    const key = generatePrivateKey();
    const v = await signVerdict(key, unsigned);
    const address = watcherAddress(key);
    const tampered = [
      { ...v, verdict: 'match' as const },
      { ...v, roundId: '01K8V3R4N5P6Q7S8T9VWXYZABD' },
      { ...v, subject: 'stakes_round' as const },
      { ...v, mode: 'free' as const },
      { ...v, reasons: [] },
      { ...v, checkedAt: v.checkedAt + 1 },
    ];
    for (const t of tampered) {
      await expect(verifyVerdict(t, address), JSON.stringify(t)).resolves.toBe(false);
    }
  });

  it('signs the same bytes whatever order the fields were built in', () => {
    const reordered: UnsignedVerdict = {
      checkedAt: unsigned.checkedAt,
      reasons: unsigned.reasons,
      verdict: unsigned.verdict,
      mode: unsigned.mode,
      roundId: unsigned.roundId,
      subject: unsigned.subject,
    };
    expect(verdictMessage(reordered)).toBe(verdictMessage(unsigned));
    expect(verdictMessage(unsigned)).toMatch(/^flocked-watcher-verdict\/1\n\{"subject":/);
  });

  it('pages on anything but a match', () => {
    expect(pages('match')).toBe(false);
    expect(pages('mismatch')).toBe(true);
    expect(pages('unable')).toBe(true);
  });

  it('refuses a WATCHER_KEY that is not 32 bytes of hex', () => {
    const key = generatePrivateKey();
    expect(watcherKey(key)).toBe(key);
    expect(watcherKey(key.slice(2))).toBe(key);
    expect(() => watcherKey(undefined)).toThrow(/WATCHER_KEY/);
    expect(() => watcherKey('0xdeadbeef')).toThrow(/WATCHER_KEY/);
  });
});
