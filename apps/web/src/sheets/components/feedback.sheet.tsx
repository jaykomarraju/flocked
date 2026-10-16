// Components › Feedback (Paper `components/feedback/{light,dark}/desktop`, sheet 6 of 9): how the app
// talks back. Toast, errors, empty state, skeleton and offline banner are the real components, and so
// are the "See past rounds" pill and the mobile header above the banner.
import { VOICE } from '@flocked/shared';
import type { ReactNode } from 'react';
import { ComponentSheet, SheetSectionHead } from '../SheetChrome';
import type { SheetDef, SheetTheme } from '../types';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorBox } from '../../ui/ErrorBox';
import { MobileHeader } from '../../ui/MobileHeader';
import { OfflineBanner } from '../../ui/OfflineBanner';
import { Skeleton } from '../../ui/Skeleton';
import { Toast } from '../../ui/Toast';
import s from './feedback.module.css';

const noop = () => undefined;

/** Paper draws the header's avatar as a blank circle: a signed-in account with an empty picture. */
const BLANK_PICTURE =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E';

function Column({
  label,
  note,
  wide,
  children,
}: {
  label: ReactNode;
  note: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? `${s.column} ${s.wide}` : s.column}>
      {label}
      {children}
      <p className={s.note}>{note}</p>
    </div>
  );
}

function FeedbackSheet({ theme }: { theme: SheetTheme }) {
  return (
    <ComponentSheet
      theme={theme}
      index={6}
      title="Feedback"
      intro="How the app talks back: toasts, errors, empty and loading states, and the offline banner. No red: errors are ink with an icon, because the accent belongs to winning."
    >
      <section className={s.toasts}>
        <SheetSectionHead
          title="Toast and error"
          note="Bottom of the screen, above the nav bar. Fades in on motion.fade."
        />
        <div className={s.row}>
          <Column
            label={<p className="type-body-strong">Toast</p>}
            note="Ink fill, bg text. Leaves after 4 seconds. One at a time; a new one replaces the old."
          >
            <Toast message="Reminder set for 8:55pm." action={{ label: 'Undo', onClick: noop }} />
          </Column>
          <Column
            label={<p className="type-body-strong">Error</p>}
            note="Surface, ink border, error icon. Stays until retried or dismissed. Voice line VOICE.error for anything unexpected."
          >
            <ErrorBox onRetry={noop} />
          </Column>
          <Column
            label={<p className="type-body-strong">Error with a known cause</p>}
            note="A 4xx on entry says what happened and keeps the selection (Client app, entry flow). No retry when retrying can't help."
          >
            <ErrorBox message={VOICE.entryClosed} />
          </Column>
        </div>
      </section>
      <section className={`${s.row} ${s.ruled}`}>
        <Column
          wide
          label={<h2 className="type-title">Empty state</h2>}
          note={
            'Neutral sheep, voice line VOICE.emptyState in the title role, and at most one way out. Lists use the same layout with their own line, e.g. "No rounds yet."'
          }
        >
          <EmptyState
            className={s.box}
            action={
              <Button variant="secondary" size="small">
                See past rounds
              </Button>
            }
          />
        </Column>
        <Column
          wide
          label={<h2 className="type-title">Skeleton loading</h2>}
          note="Line-filled blocks in the shape of the real content (here: Today). No shimmer, since gradients are out. Shown only after 300ms so fast loads never flash it."
        >
          <div className={`${s.box} ${s.skeletonFrame}`}>
            <Skeleton delay={0} />
          </div>
        </Column>
      </section>
      <section className={`${s.row} ${s.ruled}`}>
        <div className={`${s.column} ${s.wide}`}>
          <h2 className="type-title">Offline banner</h2>
          <div className={s.phone}>
            <MobileHeader
              user={{ handle: 'flock', avatarUrl: BLANK_PICTURE }}
              onSignIn={noop}
              onYou={noop}
            />
            <OfflineBanner />
            <div className={s.content} aria-hidden="true">
              <div className={s.contentLine} data-width="60" />
              <div className={s.contentLine} data-width="85" />
            </div>
          </div>
        </div>
        <div className={`${s.wide} ${s.behavior}`}>
          <p className="type-body-strong">Behavior</p>
          <p className={s.behaviorText}>
            Sits under the header and pushes content down; never covers it. Not dismissible. The CTA
            disables while it shows, and countdowns keep running from the local clock. On reconnect
            it leaves and a toast says &quot;Back online.&quot; On desktop it spans the content
            column.
          </p>
        </div>
      </section>
    </ComponentSheet>
  );
}

const sheet: SheetDef = {
  name: 'components/feedback',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <FeedbackSheet theme={state === 'dark' ? 'dark' : 'light'} />,
};

export default sheet;
