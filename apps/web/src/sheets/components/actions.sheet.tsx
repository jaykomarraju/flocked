// Components › Actions (Paper `components/actions/{light,dark}/desktop`, sheet 2 of 9): the primary
// CTA, the secondary pill, the mode toggle and the tabs, each drawn by the real component.
import type { ReactNode } from 'react';
import { ComponentSheet } from '../SheetChrome';
import type { SheetDef, SheetTheme } from '../types';
import { Button } from '../../ui/Button';
import { ModeToggle } from '../../ui/ModeToggle';
import { Tabs } from '../../ui/Tabs';
import s from './actions.module.css';

const noop = () => undefined;

/** A section: a 176-wide title and note, then the states. */
function Section({
  title,
  note,
  ruled = false,
  children,
}: {
  title: string;
  note: string;
  ruled?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={ruled ? `${s.section} ${s.ruled}` : s.section}>
      <div className={s.intro}>
        <h2 className="type-title">{title}</h2>
        <p className={s.note}>{note}</p>
      </div>
      {children}
    </section>
  );
}

function State({ name, width, children }: { name: string; width: number; children: ReactNode }) {
  return (
    <div className={s.state} style={{ width }}>
      <p className="type-label">{name}</p>
      {children}
    </div>
  );
}

function ActionsSheet({ theme }: { theme: SheetTheme }) {
  return (
    <ComponentSheet
      theme={theme}
      index={2}
      title="Actions"
      intro="One primary action per screen, and it is the only button that gets the accent. Secondary actions are surface pills with an ink border. Pills are 999px round; the CTA runs full width on mobile."
    >
      <Section
        title="Primary CTA"
        note="56px tall. Label in the cta role, the only size allowed on the accent."
      >
        <State name="Default" width={188}>
          <Button>Seal my pick</Button>
        </State>
        <State name="Pressed, 0.97" width={188}>
          <Button forceState="pressed">Seal my pick</Button>
        </State>
        <State name="Loading" width={188}>
          <Button loading loadingLabel="Sealing">
            Seal my pick
          </Button>
        </State>
        <State name="Disabled" width={188}>
          <Button disabled>Seal my pick</Button>
        </State>
      </Section>
      <Section
        ruled
        title="Secondary pill"
        note="48px, or 36px small. Surface fill, 2px ink border, bodyStrong label. Remind me, Invite, Share, Verify."
      >
        <State name="Default" width={188}>
          <Button variant="secondary">Remind me</Button>
        </State>
        <State name="Hover and pressed" width={188}>
          <Button variant="secondary" forceState="hover">
            Remind me
          </Button>
        </State>
        <State name="Disabled" width={188}>
          <Button variant="secondary" disabled>
            Remind me
          </Button>
        </State>
        <State name="Small" width={188}>
          <div className={s.smallRow}>
            <Button variant="secondary" size="small">
              Share
            </Button>
            <Button variant="secondary" size="small">
              Verify
            </Button>
          </div>
        </State>
      </Section>
      <Section
        ruled
        title="Mode toggle"
        note="Segmented pill, 48px. The active mode fills with ink and gets a check. Also the leaderboard mode filter."
      >
        <State name="Free" width={212}>
          <ModeToggle value="free" onChange={noop} />
        </State>
        <State name="Stakes" width={212}>
          <ModeToggle value="stakes" onChange={noop} />
        </State>
        <State name="Stakes hidden" width={164}>
          <ModeToggle value="free" onChange={noop} stakesAvailable={false} />
        </State>
        <p className={`${s.note} ${s.aside}`}>
          Ineligible for Stakes: no toggle and no explanation on Today. A plain label keeps the mode
          visible; it is not a control, so it gets a line border, not ink.
        </p>
      </Section>
      <Section
        ruled
        title="Tabs"
        note="Leaderboards and Profile. Scrolls sideways on mobile, never wraps."
      >
        <div className={`${s.state} ${s.grow}`}>
          <p className="type-label">Active, rest, hover</p>
          <Tabs
            label="Leaderboards"
            idPrefix={`sheet-${theme}`}
            value="strays"
            onChange={noop}
            tabs={[
              { id: 'strays', label: 'Strays today' },
              { id: 'streaks', label: 'Streaks' },
              { id: 'weekly', label: 'Weekly', forceState: 'hover' },
              { id: 'creators', label: 'Creators' },
            ]}
          />
          <p className={s.note}>
            Active: bodyStrong with a 3px ink underline. Rest: body weight, still ink, so weight and
            the underline mark the active tab, not color. Hover: a 3px line underline. 44px tap
            height.
          </p>
        </div>
      </Section>
    </ComponentSheet>
  );
}

const sheet: SheetDef = {
  name: 'components/actions',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <ActionsSheet theme={state as SheetTheme} />,
};

export default sheet;
