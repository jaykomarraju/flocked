// Components › Lists (Paper `components/lists/{light,dark}/desktop`, sheet 7 of 9): the archive row
// (win, loss, refunded), the avatar sizes and the leaderboard rows, each drawn by the real component.
import { ArchiveList, ArchiveRow } from '../../ui/ArchiveRow';
import { Avatar, type AvatarSize } from '../../ui/Avatar';
import { LeaderboardList, LeaderboardRow } from '../../ui/LeaderboardRow';
import { ComponentSheet, SheetSectionHead } from '../SheetChrome';
import type { SheetDef, SheetTheme } from '../types';
import s from './lists.module.css';

const AVATAR_SIZES: AvatarSize[] = [64, 40, 32, 24];

const LEADERBOARD_NOTES = [
  {
    title: 'Anatomy',
    text: 'Rank (32px slot), avatar 40, handle in bodyStrong with a caption, value in a 72px right-aligned slot. 68px rows. Shown: the Streaks tab; the other tabs swap the value (points, wins, creator score).',
  },
  {
    title: 'Stray-streak highlight',
    text: 'A stray streak that is still alive gets an accent pill with a cta-role number (accent text alone would need 24px). Ended streaks stay ink. Nothing else on a board uses the accent.',
  },
  {
    title: 'You',
    text: 'Your row lifts onto a surface card with an ink border and a "You" pill. If you\'re off the visible page, it pins to the bottom of the list.',
  },
];

function ListsSheet({ theme }: { theme: SheetTheme }) {
  return (
    <ComponentSheet
      theme={theme}
      index={7}
      title="Lists"
      intro="Archive, Profile, Claims and Leaderboards. Rows sit on bg with line dividers; fixed-width slots keep ranks, avatars and values in lanes."
    >
      <div className={s.row}>
        <section className={s.column}>
          <SheetSectionHead title="List row" />
          <ArchiveList>
            <ArchiveRow
              to="/r/6"
              date="Tue, Oct 6"
              mode="free"
              question="Would you rather fight one horse-sized duck or 100 duck-sized horses?"
              result="win"
              split={{ first: 38, winner: 'first' }}
            />
            <ArchiveRow
              to="/r/5"
              date="Mon, Oct 5"
              mode="stakes"
              question="Is a hot dog a sandwich?"
              result="loss"
              split={{ first: 71, winner: 'second' }}
            />
            <ArchiveRow
              to="/r/4"
              date="Sun, Oct 4"
              mode="free"
              question="Cereal: milk first or cereal first?"
              result="refunded"
              split={{ first: 50, winner: 'tie' }}
            />
          </ArchiveList>
          <p className={s.note}>
            Archive and Profile. Date and mode in caption, question in bodyStrong, a 6px split
            (accent only on the winning side; a tie stays ink), your result in a 96px slot. Whole
            row links to Round detail.
          </p>
        </section>
        <section className={s.column}>
          <SheetSectionHead title="Avatar" />
          <div className={s.avatars}>
            {AVATAR_SIZES.map((size) => (
              <div key={size} className={s.avatarSample}>
                <Avatar handle="woolgatherer" size={size} />
                <span className={s.sizeLabel}>{size}</span>
              </div>
            ))}
          </div>
          <p className={s.note}>
            Circle with an ink ring (2px at 40 and up, 1.5px below). The Farcaster or Base profile
            picture fills it; without one, the handle&apos;s first letter in Fredoka on surface. 64
            on Profile, 40 on boards, 32 in the header, 24 inline.
          </p>
        </section>
      </div>
      <div className={`${s.row} ${s.ruled}`}>
        <section className={s.column}>
          <SheetSectionHead title="Leaderboard row" />
          <LeaderboardList aria-label="Streaks">
            <LeaderboardRow
              rank={1}
              handle="woolgatherer"
              caption="Still running"
              value={14}
              highlight
            />
            <LeaderboardRow rank={2} handle="baa_humbug" caption="Ended Oct 5" value={11} />
            <LeaderboardRow rank={3} handle="ewe_turn" caption="Ended Oct 2" value={9} />
            <LeaderboardRow rank={148} handle="jay" value={3} you pinned />
          </LeaderboardList>
        </section>
        <div className={s.notes}>
          {LEADERBOARD_NOTES.map((n) => (
            <div key={n.title} className={s.noteBlock}>
              <h3 className="type-body-strong">{n.title}</h3>
              <p className={s.noteText}>{n.text}</p>
            </div>
          ))}
        </div>
      </div>
    </ComponentSheet>
  );
}

const sheet: SheetDef = {
  name: 'components/lists',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <ListsSheet theme={state as SheetTheme} />,
};

export default sheet;
