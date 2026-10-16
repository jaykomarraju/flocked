// Components › Forms and overlays (Paper `components/forms-overlays/{light,dark}/desktop`, sheet 8 of
// 9): the form field's empty, focus and error states, the onboarding modal (card 1 of 3) and the
// Stakes verification bottom sheet, each drawn by the real components. The overlays render inline so
// they sit in the artboard's demo frames. The onboarding card's own content (count, sheep, title,
// body, dots, CTA) is composed here from plain elements until its own component exists.
import type { ReactNode } from 'react';
import { Mascot } from '@flocked/shared/mascot/react';
import { BottomSheet } from '../../ui/BottomSheet';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { DialogTitle, Modal, ModalCloseButton } from '../../ui/Modal';
import { TextButton } from '../../ui/TextButton';
import { ComponentSheet, SheetSectionHead } from '../SheetChrome';
import type { SheetDef, SheetTheme } from '../types';
import s from './forms-overlays.module.css';

const HELPER = 'Two sides, ends with a question mark.';

/** The sheet's overlays stay open: closing does nothing on a drawing. */
function stayOpen() {}

function FieldState({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className={s.state}>
      <p className="type-body-strong">{name}</p>
      {children}
    </div>
  );
}

function FormsOverlaysSheet({ theme }: { theme: SheetTheme }) {
  return (
    <ComponentSheet
      theme={theme}
      index={8}
      title="Forms and overlays"
      intro="Submit, Settings and Onboarding. Fields are ink-bordered like every other control. Overlays dim the page with the flat scrim token, never a blur or a shadow."
    >
      <section className={s.fieldSection}>
        <SheetSectionHead
          title="Form field"
          note="Label above, helper or error below. Validates as you type on Submit."
        />
        <div className={s.states}>
          <FieldState name="Empty">
            <Field
              label="Your question"
              placeholder="Would you rather…"
              helper={HELPER}
              maxLength={90}
            />
          </FieldState>
          <FieldState name="Focus, typing">
            <Field
              label="Your question"
              defaultValue="Is cereal a soup?"
              helper={HELPER}
              maxLength={90}
              forceState="focus"
            />
          </FieldState>
          <FieldState name="Error">
            <Field
              label="Your question"
              defaultValue="Is cereal a soup"
              helper={HELPER}
              maxLength={90}
              error="Needs a question mark at the end."
            />
          </FieldState>
        </div>
        <p className={s.note}>
          52px tall, 16px radius, body text. Placeholder in muted. Focus adds the foundation ring.
          Error thickens the border to 3px, adds the error icon and swaps the helper for a
          600-weight message; no color change, so it reads in both modes and without color.
        </p>
      </section>
      <div className={s.overlays}>
        <section className={s.modalDemo}>
          <SheetSectionHead title="Modal" />
          <Modal open inline onClose={stayOpen} scrimClassName={s.demoScrim}>
            <div className={s.modalTop}>
              <span className="type-number-small">1 of 3</span>
              <ModalCloseButton />
            </div>
            <div className={s.mascot}>
              <Mascot pose="neutral" size={120} />
            </div>
            <div className={s.copy}>
              <DialogTitle className={s.cardTitle}>Pick the side fewer people pick</DialogTitle>
              <p className="type-body">
                One question a day, two answers. When the picks unseal, the smaller side wins.
              </p>
            </div>
            <div className={s.dots} aria-hidden="true">
              <span className={s.dotActive} />
              <span className={s.dot} />
              <span className={s.dot} />
            </div>
            <Button>Next</Button>
          </Modal>
          <p className={s.note}>
            Onboarding, card 1 of 3. Surface card, 2px ink border, 400 max wide, on the flat scrim
            token: ink at 40% in light, black at 60% in dark. Close and Escape dismiss; focus stays
            inside. Opens with motion.fade, no scale.
          </p>
        </section>
        <section className={s.sheetDemo}>
          <SheetSectionHead title="Bottom sheet" />
          <BottomSheet open inline onClose={stayOpen} scrimClassName={s.demoScrim}>
            <div className={s.copy}>
              <DialogTitle className="type-title">Stakes needs a verified account</DialogTitle>
              <p className="type-body">
                Verify with Coinbase to play for USDC. It opens in your browser and takes about a
                minute.
              </p>
            </div>
            <Button>Verify with Coinbase</Button>
            <TextButton onClick={stayOpen}>Not now</TextButton>
          </BottomSheet>
          <p className={s.note}>
            Mobile choices and confirmations. Slides up on motion.spring; drag down, tap the scrim
            or Not now to close. On desktop it becomes the modal.
          </p>
        </section>
      </div>
    </ComponentSheet>
  );
}

const sheet: SheetDef = {
  name: 'components/forms-overlays',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <FormsOverlaysSheet theme={state as SheetTheme} />,
};

export default sheet;
