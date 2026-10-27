// The "Claim all" confirmation (Paper `core/claims/claim-all/*`; docs/design/screens.md "Core flow
// decisions (W3-C.2)": claiming confirms first, because the destination wallet and the payout that
// isn't open yet need saying). A bottom sheet on mobile and a 400-wide modal from tablet up, like
// the sign-in dialog. Its CTA sends every ready payout in one sponsored batch.
import type { Breakpoint } from '../../theme';
import { BottomSheet } from '../../ui/BottomSheet';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import { DialogTitle } from '../../ui/useDialog';
import { formatUsdc } from '../../ui/amounts';
import { CLAIMING, NOT_NOW, claimTotal, confirmLine } from './copy';
import s from './ClaimConfirm.module.css';

/** One ready payout as the confirm lists it: "Wed, Oct 7 · Won" and its amount. */
export interface ConfirmItem {
  id: string;
  label: string;
  /** USDC base units. */
  amount: bigint;
}

export interface ClaimConfirmProps {
  breakpoint: Breakpoint;
  open: boolean;
  onClose: () => void;
  /** The ready payouts going out in this batch. */
  items: ConfirmItem[];
  /** Their total, USDC base units. */
  total: bigint;
  /** The destination wallet, truncated ("0x3f2c…a91c"); null when it isn't known yet. */
  wallet: string | null;
  /** What this batch leaves behind: "The Oct 8 payout opens at 11:03pm. Claim it then." */
  waiting: string | null;
  claiming?: boolean;
  onConfirm?: () => void;
  /** Drawn in place (the design sheets) rather than over the page. */
  inline?: boolean;
}

export function ClaimConfirm({ breakpoint, open, onClose, inline, ...panel }: ClaimConfirmProps) {
  return breakpoint === 'mobile' ? (
    <BottomSheet open={open} onClose={onClose} inline={inline} className={s.sheet}>
      <ClaimConfirmPanel {...panel} onClose={onClose} />
    </BottomSheet>
  ) : (
    <Modal
      open={open}
      onClose={onClose}
      closeOnScrim
      inline={inline}
      scrimClassName={inline ? s.inlineScrim : undefined}
      className={s.modal}
    >
      <ClaimConfirmPanel {...panel} onClose={onClose} />
    </Modal>
  );
}

type PanelProps = Omit<ClaimConfirmProps, 'breakpoint' | 'open' | 'inline'>;

function ClaimConfirmPanel({
  items,
  total,
  wallet,
  waiting,
  claiming = false,
  onConfirm,
  onClose,
}: PanelProps) {
  const cta = claimTotal(total);
  return (
    <>
      <div className={s.heading}>
        <DialogTitle className="type-title">{cta}</DialogTitle>
        <p className="type-body">{confirmLine(items.length, wallet)}</p>
      </div>
      <ul className={s.box}>
        {items.map((item) => (
          <li key={item.id} className={s.boxRow}>
            <span className="type-label">{item.label}</span>
            <span className="type-number">{formatUsdc(item.amount)} USDC</span>
          </li>
        ))}
      </ul>
      {waiting === null ? null : <p className={`type-label ${s.waiting}`}>{waiting}</p>}
      <div className={s.actions}>
        <Button loading={claiming} loadingLabel={CLAIMING} onClick={onConfirm}>
          {cta}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {NOT_NOW}
        </Button>
      </div>
    </>
  );
}
