// TL-1, the browser half (W9-C; docs/plan/traceability.md): the app's production bundle encrypts a
// pick in Chromium, and the Worker's classifier (@flocked/tlock `classify`, the code settlement runs
// in workerd; its Workers half is packages/tlock/test/roundtrip.workers.test.ts) opens it with the
// recorded quicknet signature for its round. The page runs the real Free entry flow against a mocked
// world (world.ts) whose round targets the recorded beacon round. `today.spec.ts` also seals a pick in
// the browser on the stack, which the stack's Worker then opens with its local beacon at the reveal.
import { VOICE } from '@flocked/shared';
import {
  QUICKNET,
  classify,
  decodePlaintext,
  decryptWithSignature,
  fromBase64Url,
  isCanonicalHeader,
  roundRefFromUlid,
} from '@flocked/tlock';
import { expect, test } from '../fixtures';
import { QUESTION, RECORDED_ROUND, RECORDED_SIGNATURE, mockWorld, readStoredPick } from './world';

test('TL-1: the production bundle encrypts in Chromium; the recorded signature opens it', async ({
  page,
}) => {
  const world = await mockWorld(page);
  await page.goto('/');
  await page.getByRole('radio', { name: QUESTION.options[1] }).click();
  await page.getByRole('button', { name: 'Seal my pick' }).click();
  await expect(page.getByText(VOICE.sealed)).toBeVisible();

  expect(world.posted).toHaveLength(1);
  const body = world.posted[0]!;
  // Only the stake, the ciphertext and the day's Turnstile token leave the browser.
  expect(Object.keys(body).sort()).toEqual(['ciphertext', 'stake', 'turnstileToken']);
  expect(body.stake).toBe('25');
  const ct = fromBase64Url(body.ciphertext);
  if (!ct) throw new Error('not base64url');
  expect(isCanonicalHeader(ct, QUICKNET, RECORDED_ROUND)).toBe(true);

  const verdict = await classify({
    ct,
    chain: QUICKNET,
    beaconRound: RECORDED_ROUND,
    signature: RECORDED_SIGNATURE,
    roundRef: roundRefFromUlid(world.round.id),
  });
  expect(verdict).toMatchObject({ valid: true, optionIndex: 1 });
  const plaintext = decodePlaintext(await decryptWithSignature(QUICKNET, ct, RECORDED_SIGNATURE));

  // The device kept the plaintext's fields and a receipt that checked out.
  const stored = await readStoredPick(page, world);
  expect(stored).toMatchObject({ optionIndex: 1, stake: '25', mismatches: [] });
  expect(stored?.nonce).toBe(`0x${Buffer.from(plaintext!.nonce).toString('hex')}`);
  expect(stored?.ciphertext).toBe(body.ciphertext);
});
