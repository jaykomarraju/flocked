// Core flow › Claims (Paper `core/claims/{list,claim-all,pending,empty}/{mobile,tablet,desktop}`):
// the real ClaimsView in the real ShellFrame with Paper's example data — two ready payouts and one
// that opens at 11:03pm, 17.67 USDC ready in all. Claims is a Stakes surface, so the header's
// balance slot carries the 30-day net (`GET /me` has no field for it; the live page leaves the
// shell's slot alone). It is reached from You, so the mobile nav marks You and the desktop header
// shows no active link.
//
//   list       the card, the three rows and the destination note
//   claim-all  the confirm sheet (mobile) / modal (tablet up) over the list
//   pending    the batch is out: CTA "Claiming", the Base line, both ready rows claiming
//   empty      the neutral sheep and "Back to Today" (a short screen: 844 on mobile)
import { ClaimConfirm } from '../../features/claims/ClaimConfirm';
import { ClaimsView, type ClaimRow } from '../../features/claims/ClaimsView';
import { PENDING_NOTE } from '../../features/claims/copy';
import type { Balance } from '../../ui/BalanceSlot';
import type { SheetDef } from '../types';
import { CoreArtboard, EXAMPLE_PLAYER } from './frames';

const noop = () => undefined;

const STATES = ['list', 'claim-all', 'pending', 'empty'] as const;
type State = (typeof STATES)[number];
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

/** Paper draws Claims with the 30-day Stakes net in the balance slot: "30 days: +12 USDC". */
const STAKES_NET: Balance = { mode: 'stakes', net: 12_000_000n };

/** The destination wallet, as the page truncates it. */
const WALLET = '0x3f2c…a91c';

const ROWS: ClaimRow[] = [
  {
    id: 'oct-7',
    date: 'Wed, Oct 7',
    result: 'Won',
    question: 'Pineapple on pizza: yes or no?',
    amount: 12_670_000n,
    status: 'Ready',
    ready: true,
  },
  {
    id: 'oct-5',
    date: 'Mon, Oct 5',
    result: 'Refunded',
    question: 'Is cereal a soup?',
    amount: 5_000_000n,
    status: 'Ready',
    ready: true,
  },
  {
    id: 'oct-8',
    date: 'Thu, Oct 8',
    result: 'Won',
    question: 'One horse-sized duck or 100 duck-sized horses?',
    amount: 11_750_000n,
    status: 'Opens 11:03pm',
    ready: false,
  },
];

const READY_TOTAL = 17_670_000n;
const READY_NOTE = '2 of 3 are ready. The third opens at 11:03pm.';
const WAITING_NOTE = 'The Oct 8 payout opens at 11:03pm. Claim it then.';

const CLAIMING_ROWS: ClaimRow[] = ROWS.map((row) =>
  row.ready ? { ...row, status: 'Claiming' } : row,
);

const CONFIRM_ITEMS = ROWS.filter((r) => r.ready).map((r) => ({
  id: r.id,
  label: `${r.date} · ${r.result}`,
  amount: r.amount,
}));

const sheet: SheetDef = {
  name: 'core/claims',
  artboards: STATES.flatMap((state) => BREAKPOINTS.map((bp) => `${state}/${bp}`)),
  render: (state, breakpoint) => {
    const s = state as State;
    const empty = s === 'empty';
    const pending = s === 'pending';
    return (
      <CoreArtboard
        breakpoint={breakpoint}
        player={{ user: EXAMPLE_PLAYER.user, balance: STAKES_NET }}
        active="you"
        short={empty}
        overlay={
          s === 'claim-all' ? (
            <ClaimConfirm
              breakpoint={breakpoint}
              open
              inline
              onClose={noop}
              items={CONFIRM_ITEMS}
              total={READY_TOTAL}
              wallet={WALLET}
              waiting={WAITING_NOTE}
            />
          ) : undefined
        }
      >
        <ClaimsView
          breakpoint={breakpoint}
          rows={empty ? [] : pending ? CLAIMING_ROWS : ROWS}
          readyTotal={READY_TOTAL}
          note={empty ? null : pending ? PENDING_NOTE : READY_NOTE}
          wallet={WALLET}
          claiming={pending}
          onClaimAll={noop}
          onBackToToday={noop}
        />
      </CoreArtboard>
    );
  },
};

export default sheet;
