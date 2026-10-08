// DO-3: receipts verify against the root, and no acknowledged entry is missing from the root when
// entries race the close at `closesAt` (spec "Real-time and the reveal": at closesAt, set closed,
// wait for in-flight entries, reconcile leaves against D1, build the root from committed leaves).
import { env, runInDurableObject } from 'cloudflare:test';
import { freeCommitmentTree } from '@flocked/settle';
import { MODE_CODES, ulidToBytes, ulidToHex, type CreateEntryResponse } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { recoverReceiptSigner } from '../../src/crypto/receipt.js';
import type { RpcResult } from '../../src/do/types.js';
import {
  alarmAt,
  commitmentLeafHash,
  createRound,
  createUser,
  readMeta,
  sealedPick,
  seqs,
  setClock,
  useTestSigner,
  verifyProof,
  type TestRound,
} from './helpers.js';

let signer: Hex;
beforeAll(() => {
  signer = useTestSigner();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs the close (the clock is already at closesAt). */
async function closeRound(r: TestRound): Promise<void> {
  await alarmAt(r.stub, r.locked.closesAt);
  expect((await readMeta(r.stub))?.done).toContain('close');
}

describe('DO-3: close-boundary race', () => {
  it('every acknowledged entry is in the root, and its receipt verifies against it', async () => {
    const r = await createRound();
    const scope = r.locked.roomId as string;
    const { closesAt } = r.locked;
    setClock(closesAt - 1);
    await r.stub.init(r.locked);

    const N = 40;
    const users = await Promise.all(
      Array.from({ length: N }, (_, i) => createUser(i % 7 === 3 ? 5 : 100, scope)),
    );
    const cts = await Promise.all(users.map((_, i) => sealedPick(r.locked, (i % 2) as 0 | 1)));
    const stakes = users.map((_, i) => String(10 + (i % 5) * 5));

    // Wave 1 is admitted before closesAt; once some of it is in flight, the clock reaches closesAt
    // and the close alarm runs while those entries are still committing. Wave 2 arrives after.
    const settled = new Set<number>();
    const call = (i: number) =>
      r.stub
        .enterFree({
          roundId: r.locked.roundId,
          userId: users[i] as string,
          body: { stake: stakes[i] as string, ciphertext: cts[i] as string },
        })
        .then((res: RpcResult<CreateEntryResponse>) => {
          settled.add(i);
          return res;
        });
    const wave1 = Array.from({ length: N / 2 }, (_, i) => call(i));
    let inflightAtClose = 0;
    for (let k = 0; k < 50 && inflightAtClose === 0; k++) {
      await tick();
      inflightAtClose = await runInDurableObject(
        r.stub,
        (instance) => (instance as unknown as { inflight: Map<string, unknown> }).inflight.size,
      );
    }
    setClock(closesAt);
    const closing = closeRound(r);
    const wave2 = Array.from({ length: N / 2 }, (_, i) => call(N / 2 + i));
    const results = await Promise.all([...wave1, ...wave2]);
    await closing;
    expect(inflightAtClose).toBeGreaterThan(0);

    const acked = results.flatMap((res, i) => (res.ok ? [{ i, value: res.value }] : []));
    const refused = results.flatMap((res, i) => (res.ok ? [] : [{ i, code: res.code }]));
    expect(acked.length).toBeGreaterThan(0);
    for (const x of refused) expect(['round_closed', 'insufficient_balance']).toContain(x.code);
    // Everything after the clock reached closesAt was refused.
    for (const x of acked) expect(x.i).toBeLessThan(N / 2);

    // The root covers exactly the acknowledged entries, with gap-free seqs.
    const meta = await readMeta(r.stub);
    const close = meta?.freeClose;
    expect(meta?.status).toBe('closed');
    expect(close?.entryCount).toBe(acked.length);
    expect(await seqs(r.locked.roundId)).toEqual(acked.map((_, k) => k));
    expect(close?.totalStake).toBe(
      String(acked.reduce((s, x) => s + Number(x.value.entry.stake), 0)),
    );
    const root = close?.root as Hex;
    const d1 = await env.DB.prepare(
      "SELECT r.status AS round_status, m.commitment_root FROM rounds r JOIN round_modes m ON m.round_id = r.id AND m.mode = 'free' WHERE r.id = ?1",
    )
      .bind(r.locked.roundId)
      .first<{ round_status: string; commitment_root: string }>();
    expect(d1).toEqual({ round_status: 'closed', commitment_root: root });

    // Each receipt: signed by the receipt key, and its leaf proves into the root.
    const tree = freeCommitmentTree(
      acked.map(({ value: { receipt } }) => ({
        roundId: ulidToBytes(receipt.roundId),
        mode: MODE_CODES.free,
        userIdHash: receipt.userIdHash as Hex,
        stake: BigInt(receipt.stake),
        commitment: receipt.commitment as Hex,
        seq: receipt.seq,
      })),
    );
    expect(tree.root).toBe(root);
    for (const { value } of acked) {
      const rc = value.receipt;
      expect(await recoverReceiptSigner(rc)).toBe(signer);
      expect(rc.seq).toBeLessThan(acked.length);
      const leaf = commitmentLeafHash([
        ulidToHex(rc.roundId),
        MODE_CODES.free,
        rc.userIdHash,
        BigInt(rc.stake),
        rc.commitment,
        rc.seq,
      ]);
      expect(verifyProof(root, leaf, tree.proof(rc.seq))).toBe(true);
    }

    // Refused users were not debited.
    for (const x of refused) {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ?1 AND reason = 'stake'",
      )
        .bind(users[x.i])
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    }
  });

  it('an entry committed to D1 whose leaf was lost is recovered into the root at close', async () => {
    const r = await createRound();
    const scope = r.locked.roomId as string;
    setClock(r.locked.closesAt - 60_000);
    await r.stub.init(r.locked);
    const a = await createUser(100, scope);
    const b = await createUser(100, scope);
    for (const u of [a, b]) {
      const res = await r.stub.enterFree({
        roundId: r.locked.roundId,
        userId: u,
        body: { stake: '10', ciphertext: await sealedPick(r.locked) },
      });
      expect(res.ok).toBe(true);
    }
    // b's reply and leaf were lost after the commit.
    await runInDurableObject(r.stub, (_i, state) => {
      state.storage.sql.exec('DELETE FROM leaves WHERE seq = 1');
    });
    setClock(r.locked.closesAt);
    await closeRound(r);
    const close = (await readMeta(r.stub))?.freeClose;
    expect(close?.entryCount).toBe(2);
    const recovered = await runInDurableObject(r.stub, (_i, state) =>
      state.storage.sql
        .exec<{ seq: number }>('SELECT seq FROM leaves WHERE recovered = 1')
        .toArray(),
    );
    expect(recovered).toEqual([{ seq: 1 }]);
    expect((await r.stub.getState()).modes.free).toMatchObject({ entrantCount: 2, pool: '20' });
  });

  it('a round with no Free entries closes with no root and nothing to anchor', async () => {
    const r = await createRound();
    setClock(r.locked.closesAt - 1);
    await r.stub.init(r.locked);
    setClock(r.locked.closesAt);
    await closeRound(r);
    expect((await readMeta(r.stub))?.freeClose).toMatchObject({
      root: null,
      entryCount: 0,
      totalStake: '0',
      anchor: 'none',
    });
  });
});
