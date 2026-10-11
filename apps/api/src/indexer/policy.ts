// ALERT-8: any FlockedEscrow or FlockedAnchor event the backend didn't send raises ALERT_FOREIGN_EVENT
// (spec "Non-functional requirements" › Alerts), for example a guardian void or veto.
//
// "Didn't send" applies to role-only events. Players cause `Entered`, `Claimed`, `RefundClaimed` and
// `Withdrawn`; anyone may call `finalize`, `refundTooFew` and `refundTimeout`, and a claim finalizes a
// due round on the way, so `RoundFinalized`, `Credited` and `RoundRefunded` (except reason 4, a void)
// are open too. A foreign `Entered` (no ticket) has its own path (entered.ts).
import type { Env } from '../env.js';
import { raiseAlert } from '../lib/alert.js';
import { isSentTx } from './sent.js';
import type { ChainEvent, ContractKind, HandlerContext, RpcTransaction } from './types.js';

/** `RoundRefunded` reason for `voidRound` (FlockedEscrow REASON_VOIDED). */
export const REFUND_REASON_VOIDED = 4;

/**
 * The deterministic CREATE2 deployer (contracts/script/Deploy.s.sol deploys through it). Constructor
 * events (role grants, the initial ticket signer and treasury) come from a transaction to it.
 */
export const CREATE2_FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';

/** Events anyone (a player, or anyone calling a permissionless function) can cause. */
export const OPEN_EVENTS: Readonly<Record<ContractKind, readonly string[]>> = {
  escrow: [
    'Entered',
    'Claimed',
    'RefundClaimed',
    'Withdrawn',
    'Credited',
    'RoundFinalized',
    'RoundRefunded',
  ],
  anchor: [],
};

/** Events only a role holder can cause. Every ABI event is in exactly one list (test/indexer). */
export const ROLE_EVENTS: Readonly<Record<ContractKind, readonly string[]>> = {
  escrow: [
    'RoundCreated',
    'OutcomeProposed',
    'ProposalVetoed',
    'Paused',
    'Unpaused',
    'GuardianTransferred',
    'GuardianReplaced',
    'TicketSignerSet',
    'TreasurySet',
    'Rescued',
    'TimelockScheduled',
    'TimelockExecuted',
    'TimelockCancelled',
    'RoleGranted',
    'RoleRevoked',
    'RoleAdminChanged',
    'EIP712DomainChanged',
  ],
  anchor: [
    'Locked',
    'Committed',
    'ManifestAnchored',
    'Skipped',
    'ReceiptSignerSet',
    'TimelockScheduled',
    'TimelockExecuted',
    'TimelockCancelled',
    'RoleGranted',
    'RoleRevoked',
    'RoleAdminChanged',
    'EIP712DomainChanged',
  ],
};

/** 'role' when only a role holder can cause the event (unknown events and contracts included). */
export function eventPolicy(
  evt: Pick<ChainEvent, 'contractKind' | 'event' | 'args'>,
): 'open' | 'role' {
  if (evt.contractKind === null) return 'role';
  if (evt.contractKind === 'escrow' && evt.event === 'RoundRefunded') {
    return Number(evt.args.reason) === REFUND_REASON_VOIDED ? 'role' : 'open';
  }
  return OPEN_EVENTS[evt.contractKind].includes(evt.event) ? 'open' : 'role';
}

/** A contract-creation transaction, directly or through the CREATE2 factory. */
export function isDeploymentTx(tx: RpcTransaction): boolean {
  return tx.to === null || tx.to === CREATE2_FACTORY;
}

/** The ALERT-8 handler (registered for every event in handlers.ts). */
export async function unsentTxHandler(
  evt: ChainEvent,
  env: Env,
  ctx: HandlerContext,
): Promise<void> {
  if (evt.removed || eventPolicy(evt) === 'open') return;
  if (await isSentTx(env.DB, evt.chainId, evt.txHash)) return;
  const tx = await ctx.rpc.transaction(evt.txHash);
  if (tx && isDeploymentTx(tx)) return;
  raiseAlert(env, 'ALERT_FOREIGN_EVENT', {
    kind: 'unsent_tx',
    chainId: evt.chainId,
    contract: evt.contract,
    contractKind: evt.contractKind,
    eventName: evt.event,
    args: evt.args,
    txHash: evt.txHash,
    from: tx?.from ?? null,
    blockNumber: evt.blockNumber,
    logIndex: evt.logIndex,
  });
}
