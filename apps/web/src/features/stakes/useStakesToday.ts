// Everything Today needs for the Stakes mode (spec "Client app" › Today and Entry flow (Stakes)),
// so the screen itself stays one composition:
//   - whether Stakes is offered at all, from `/me` (AC-8: hidden for every reason but `not_verified`);
//   - the round's fixed stake;
//   - the round config check, run as soon as the player switches to Stakes, so the round's special
//     rules (`config-warning`) or its refusal (`stakes-entry/mismatch`) are on screen before they
//     press anything, not after;
//   - the entry itself, and the verification flow for a player who hasn't verified yet.
import type { MeResponse, RoundView } from '@flocked/shared';
import { useCallback, useEffect, useState } from 'react';
import type { Config } from 'wagmi';
import { ApiError, type ApiClient } from '../../api/client';
import type { MiniApp } from '../../auth/miniapp';
import { clientChain } from '../../crypto/chain';
import type { Address } from 'viem';
import type { TodayNotice } from '../today/TodayView';
import { checkRoundConfig, escrowReader, type ConfigCheck } from './configCheck';
import {
  changeLogLine,
  CONFIG_NOTICE_TITLE,
  configNoticeBody,
  CONFIG_UNREADABLE,
  MISMATCH_DETAILS,
  MISMATCH_TITLE,
  mismatchBody,
  mismatchRow,
  PENDING_CTA,
  PENDING_NOTE,
  prepareErrorMessage,
  VERIFY_CTA,
} from './copy';
import { stakesOffer, type StakesOffer } from './eligibility';
import type { StoredStakesPick } from './picks';
import { useStakesEntry, type StakesEnv } from './useStakesEntry';
import { useVerify } from './useVerify';

export interface StakesTodayOptions {
  client: ApiClient;
  wagmi: Config;
  me: MeResponse | null;
  round: RoundView;
  /** Stakes is the mode on screen: the config check runs, and the entry flow is live. */
  selected: boolean;
  refresh: () => Promise<unknown>;
  miniApp: MiniApp | null;
  onEntered: (pick: StoredStakesPick) => void;
  /** The connected smart wallet, or null until the player connects one. */
  wallet: Address | null;
  /** Asks the wallet for an account; a player signed in by email has none yet. */
  connect: () => Promise<Address>;
  env?: () => StakesEnv;
}

function defaultEnv(): StakesEnv {
  const chain = clientChain();
  return { chain, reader: escrowReader(chain) };
}

export interface StakesToday {
  offer: StakesOffer;
  /** The round's fixed stake, when the player may play. */
  stakesStake: { stake: bigint; dailyCap?: bigint; overCap?: boolean } | null;
  /** The notice above the question: the round's special rules, or the refusal. */
  notice: TodayNotice | null;
  /** The mismatched fields, once the player asks to see them. */
  details: string[] | null;
  /** The CTA's label and, while the user operation is out, what it reads instead. */
  cta: { label: string; loadingLabel: string; workingNote: string };
  pending: boolean;
  /** The entry cannot be built: the CTA stays disabled. */
  blocked: boolean;
  error: { message: string; onRetry?: () => void } | null;
  /** "Seal my pick" (or "Verify with Coinbase") for the Stakes mode. */
  act: (optionIndex: 0 | 1) => void;
  /** The verification sheet is open. */
  verifying: boolean;
  closeVerify: () => void;
  verify: ReturnType<typeof useVerify>;
}

export function useStakesToday(opts: StakesTodayOptions): StakesToday {
  const { client, wagmi, me, round, selected, refresh, miniApp, onEntered, wallet } = opts;
  const { connect } = opts;
  const env = opts.env ?? defaultEnv;
  const offer = stakesOffer(me, round.modes.stakes !== undefined);
  const [check, setCheck] = useState<ConfigCheck | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const entry = useStakesEntry(client, wagmi, onEntered, env);

  const verify = useVerify({
    client,
    tosVersion: me?.tos.currentVersion ?? '',
    eligible: offer.kind === 'play',
    refresh,
    miniApp,
    onError: (err) =>
      err instanceof ApiError ? prepareErrorMessage(err.code) : prepareErrorMessage('internal'),
  });

  // The check runs when Stakes becomes the mode on screen, and again if the round changes under it.
  useEffect(() => {
    if (!selected || offer.kind !== 'play') return;
    let live = true;
    setCheck(null);
    setShowDetails(false);
    void (async () => {
      try {
        const e = env();
        const result = await checkRoundConfig({ round, chain: e.chain, reader: e.reader });
        if (live) setCheck(result);
      } catch {
        // No trusted chain, or the RPC is down: the client refuses rather than trust the API.
        if (live) setCheck({ ok: false, reason: 'unreadable' });
      }
    })();
    return () => {
      live = false;
    };
  }, [selected, offer.kind, round, env]);

  // A refusal the entry flow itself hit (the config changed between the check and the press).
  const refusal =
    entry.state.kind === 'refused' ? entry.state.check : check && !check.ok ? check : null;

  const notice = noticeFor(refusal, check, () => setShowDetails((v) => !v));
  // "See what doesn't match" lists every differing field; "See the change log" lists each
  // non-default value with the audit row that set it (the client has no change-log route yet —
  // Admin is W11-A — so the IDs are shown here rather than linked away).
  const details = !showDetails
    ? null
    : refusal?.reason === 'mismatch'
      ? refusal.mismatches.map(mismatchRow)
      : check?.ok
        ? check.nonDefaults.map(nonDefaultRow)
        : null;

  const stakes = round.config?.stakes;
  const act = useCallback(
    (optionIndex: 0 | 1) => {
      if (offer.kind === 'verify') {
        setVerifying(true);
        return;
      }
      if (offer.kind !== 'play' || !me) return;
      const userId = me.user.id;
      void (async () => {
        // A player who signed in by email or Farcaster has no wallet yet: ask for one first.
        const from = wallet ?? (await connect().catch(() => null));
        if (!from) return;
        await entry.enter({ round, optionIndex, wallet: from, userId });
      })();
    },
    [offer.kind, wallet, connect, me, entry, round],
  );

  const pending = entry.state.kind === 'pending';
  return {
    offer,
    stakesStake: offer.kind === 'play' && stakes ? { stake: BigInt(stakes.stake) } : null,
    notice,
    details,
    cta:
      offer.kind === 'verify'
        ? { label: VERIFY_CTA, loadingLabel: VERIFY_CTA, workingNote: '' }
        : { label: 'Seal my pick', loadingLabel: PENDING_CTA, workingNote: PENDING_NOTE },
    pending,
    // Refused, still checking, or no wallet to enter with: nothing to send.
    blocked: offer.kind === 'play' && (refusal !== null || check === null || !stakes),
    error:
      entry.state.kind === 'error'
        ? {
            message: entry.state.message,
            onRetry: entry.state.known ? undefined : () => entry.reset(),
          }
        : null,
    act,
    verifying,
    closeVerify: () => setVerifying(false),
    verify,
  };
}

/** One non-default value in the expanded change log: "Stake 10 USDC (usually 5 USDC) · #A1F3". */
function nonDefaultRow(v: { field: string; value: string; usual: string; auditId: string | null }) {
  const id = v.auditId === null ? '' : ` · #${v.auditId}`;
  return `${v.field}: ${v.value} (usually ${v.usual})${id}`;
}

/** The notice above the question: a refusal first, then the round's non-default rules. */
function noticeFor(
  refusal: Extract<ConfigCheck, { ok: false }> | null,
  check: ConfigCheck | null,
  onDetails: () => void,
): TodayNotice | null {
  if (refusal?.reason === 'unreadable') {
    return { variant: 'refusal', title: MISMATCH_TITLE, body: CONFIG_UNREADABLE };
  }
  if (refusal?.reason === 'mismatch') {
    return {
      variant: 'refusal',
      title: MISMATCH_TITLE,
      body: mismatchBody(refusal.mismatches),
      link: { label: MISMATCH_DETAILS, onClick: onDetails },
    };
  }
  if (check?.ok && check.nonDefaults.length > 0) {
    const log = changeLogLine(check.nonDefaults);
    return {
      variant: 'strong',
      title: CONFIG_NOTICE_TITLE,
      body: configNoticeBody(check.nonDefaults),
      ...(log ? { link: { label: log, onClick: onDetails } } : {}),
    };
  }
  return null;
}
