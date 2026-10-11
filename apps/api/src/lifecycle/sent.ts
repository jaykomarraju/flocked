// `onTxSent` → `recordSentTx` (wave-4 pinned interfaces): every transaction the backend signs is in
// `sent_txs` before it is broadcast, so the indexer never mistakes the backend's own role-only events
// for foreign ones (ALERT-8). TxSender stops a broadcast when this throws, which is the safe side.
import type { OperatorDeps } from '../chain/operator.js';
import type { OnTxSent } from '../chain/tx.js';
import type { Env } from '../env.js';
import { recordSentTx, type SentTxKind } from '../indexer/sent.js';

const KINDS: readonly SentTxKind[] = [
  'createRound',
  'voidRound',
  'propose',
  'finalize',
  'refundTooFew',
  'refundTimeout',
  'lock',
  'commit',
  'manifest',
];

/** `anchor.commit` → `commit`, `operator.voidRound` → `voidRound` (src/chain labels). */
export function sentTxKindOf(label: string): SentTxKind {
  const kind = label.slice(label.indexOf('.') + 1) as SentTxKind;
  if (!label.includes('.') || !KINDS.includes(kind)) {
    throw new Error(`onTxSent: no sent_txs kind for the label ${label}`);
  }
  return kind;
}

/** The `onTxSent` callback for TxSender, AnchorDO and operator.ts. */
export function sentTxRecorder(
  env: Pick<Env, 'DB' | 'ENVIRONMENT' | 'FLOCKED_TEST_CLOCK'>,
): OnTxSent {
  // A batch transaction covers several round keys, so none is recorded.
  return (e) =>
    recordSentTx(env, {
      chainId: e.chainId,
      txHash: e.hash,
      kind: sentTxKindOf(e.label),
      roundKey: null,
    });
}

/** Operator dependencies for production paths: the env's providers, every send recorded. */
export function operatorDeps(env: Env): OperatorDeps {
  return { onTxSent: sentTxRecorder(env) };
}
