// PIPE-5's anvil half: the independent watcher reads only the public API and chain. It accepts the
// backend's honest Stakes proposal, rejects a proposal whose payout root does not match the exact
// public bundle, signs both verdicts, and sends the mismatch to the local pager mock.
import { flockedEscrowAbi } from '@flocked/abi';
import { ticketDigest, ticketTypedData } from '@flocked/shared';
import { roundRefFromChainId } from '@flocked/tlock';
import { bytesToHex, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { expect, poll, test } from '../fixtures';
import { scheduleRound, seal, waitRound, type Pick } from '../fixtures/rounds';
import { asRole, fundStake, mined, type Wallet } from '../fixtures/wallet';

const STAKE = 1_000_000n;
const PICKS: Pick[] = [0, 1, 1];

test.describe.configure({ mode: 'serial' });

test('PIPE-5: honest and mismatched live proposals produce signed verdicts and one proposal page', async ({
  stack,
  clock,
  wallet,
}) => {
  await clock.release();
  await fetch(`${stack.pagerUrl}/sent`, { method: 'DELETE' });

  const roundOpts = {
    opensInMs: 30_000,
    openForMs: 120_000,
    beaconDelay: 60,
    free: false,
    stakes: { stake: String(STAKE), minEntrants: 3, capMultiple: 1 },
  } as const;
  const honestScheduled = await scheduleRound(stack, roundOpts);
  // Daily rounds have a unique close time; one second keeps both rounds concurrent without
  // pretending the scheduler could create two rows for the same game boundary.
  const mismatchScheduled = await scheduleRound(stack, { ...roundOpts, openForMs: 121_000 });
  const [honest, mismatch] = await Promise.all([
    waitRound(stack, honestScheduled.roundId, 'the honest round to open', 90_000, (r) =>
      Boolean(r.status === 'open' && r.modes.stakes?.chainRoundId),
    ),
    waitRound(stack, mismatchScheduled.roundId, 'the mismatch round to open', 90_000, (r) =>
      Boolean(r.status === 'open' && r.modes.stakes?.chainRoundId),
    ),
  ]);
  const signer = privateKeyToAccount(stack.ticketSignerKey());
  const enter = async (round: typeof honest, player: Wallet, pick: Pick) => {
    const chainRoundId = BigInt(round.modes.stakes!.chainRoundId!);
    const target = { chainId: foundry.id, verifyingContract: stack.contracts.escrow };
    const ticket = {
      roundId: chainRoundId,
      wallet: player.address,
      personTag: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      expiry: BigInt(round.closesAt + 3600),
    };
    const signature = await signer.signTypedData(ticketTypedData(target, ticket));
    const recorded = await stack.seam('/stakes/tickets', {
      roundId: round.id,
      wallet: player.lower,
      personTag: ticket.personTag,
      expiry: Number(ticket.expiry),
      ticketHash: ticketDigest(target, ticket),
    });
    expect(recorded.status).toBe(201);
    await fundStake(stack, player, STAKE);
    await clock.mineTo(round.opensAt);
    const ciphertext = await seal(
      stack,
      roundRefFromChainId(chainRoundId),
      round.beaconRound,
      pick,
    );
    await mined(
      stack,
      player.client.writeContract({
        address: stack.contracts.escrow,
        abi: flockedEscrowAbi,
        functionName: 'enter',
        args: [chainRoundId, bytesToHex(ciphertext), ticket, signature],
      }),
    );
  };
  for (const pick of PICKS) await enter(honest, await wallet(), pick);
  // A one-sided result is a refund proposal. Vetoing it returns the escrow to Open while the first
  // proposal's canonical bundle remains public, allowing an independently bad re-proposal.
  for (let i = 0; i < 3; i++) await enter(mismatch, await wallet(), 1);

  const mismatchChainId = BigInt(mismatch.modes.stakes!.chainRoundId!);

  const honestProposal = await poll(
    'the honest proposal and the refund proposal to challenge',
    300_000,
    async () => {
      await clock.mine(4);
      const [h, m, manifest] = await Promise.all([
        stack.seamRound(honest.id),
        stack.seamRound(mismatch.id),
        stack.seamRaw(`/bundles/${mismatch.id}/stakes/manifest.json`),
      ]);
      return h?.stakes?.status === 'settle_proposed' &&
        m?.stakes?.status === 'refund_proposed' &&
        manifest.ok
        ? { honest: h, manifest }
        : null;
    },
  );
  const manifestBytes = new Uint8Array(await honestProposal.manifest.arrayBuffer());
  const bundleHash = keccak256(manifestBytes);

  await asRole(stack, stack.addresses.guardian, (client) =>
    client.writeContract({
      address: stack.contracts.escrow,
      abi: flockedEscrowAbi,
      functionName: 'veto',
      args: [mismatchChainId, `0x${'22'.repeat(32)}`],
    }),
  );
  await poll('the vetoed-refund hold', 60_000, async () => {
    const r = await stack.seamRound(mismatch.id);
    return r?.holds.some((hold) => hold.reason === 'refund_vetoed' && hold.releasedAt === null)
      ? true
      : null;
  });

  await asRole(stack, stack.addresses.operator, (client) =>
    client.writeContract({
      address: stack.contracts.escrow,
      abi: flockedEscrowAbi,
      functionName: 'propose',
      args: [mismatchChainId, 1, 2, 0, `0x${'11'.repeat(32)}`, bundleHash],
    }),
  );

  type Verdict = {
    subject: string;
    roundId: string;
    verdict: 'match' | 'mismatch' | 'unable';
    signature: Hex;
  };
  const verdicts = await poll('the watcher proposal verdicts', 180_000, async () => {
    await fetch(`${stack.watcherUrl}/__test/tick`, { method: 'POST' });
    const [good, bad] = await Promise.all([
      fetch(`${stack.watcherUrl}/verdicts/stakes_proposal/${honest.id}`),
      fetch(`${stack.watcherUrl}/verdicts/stakes_proposal/${mismatch.id}`),
    ]);
    if (!good.ok || !bad.ok) return null;
    return { good: (await good.json()) as Verdict, bad: (await bad.json()) as Verdict };
  });
  expect(verdicts.good).toMatchObject({
    subject: 'stakes_proposal',
    roundId: honest.id,
    verdict: 'match',
  });
  expect(verdicts.bad).toMatchObject({
    subject: 'stakes_proposal',
    roundId: mismatch.id,
    verdict: 'mismatch',
  });
  expect(verdicts.good.signature).toMatch(/^0x[0-9a-f]{130}$/);
  expect(verdicts.bad.signature).toMatch(/^0x[0-9a-f]{130}$/);

  const sent = (await (await fetch(`${stack.pagerUrl}/sent`)).json()) as {
    pages: { kind?: string; verdict?: Verdict }[];
  };
  const proposalPages = sent.pages.filter(
    (page) => page.kind === 'verdict' && page.verdict?.subject === 'stakes_proposal',
  );
  expect(proposalPages.map((page) => page.verdict?.roundId)).toContain(mismatch.id);
  expect(proposalPages.map((page) => page.verdict?.roundId)).not.toContain(honest.id);
});
