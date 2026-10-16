import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Field } from './Field';

const HELPER = 'Two sides, ends with a question mark.';

describe('Field', () => {
  it('labels the input and describes it with the helper and the counter', () => {
    render(
      <Field
        label="Your question"
        placeholder="Would you rather…"
        helper={HELPER}
        maxLength={90}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Your question' });
    expect(input).toHaveAttribute('placeholder', 'Would you rather…');
    expect(input).toHaveAccessibleDescription(`${HELPER} 0/90`);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAttribute('maxlength', '90');
  });

  it('counts as you type (uncontrolled) and passes changes on', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Field label="Your question" helper={HELPER} maxLength={90} onChange={onChange} />);
    await user.type(screen.getByRole('textbox'), 'Is cereal a soup?');
    expect(screen.getByText('17/90')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(17);
  });

  it('counts a controlled value', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [v, setV] = useState('Is cereal');
      return (
        <Field
          label="Your question"
          maxLength={90}
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
      );
    }
    render(<Controlled />);
    expect(screen.getByText('9/90')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox'), ' a soup');
    expect(screen.getByText('16/90')).toBeInTheDocument();
  });

  it('wires an error: aria-invalid, described by the message, which replaces the helper', () => {
    render(
      <Field
        label="Your question"
        defaultValue="Is cereal a soup"
        helper={HELPER}
        maxLength={90}
        error="Needs a question mark at the end."
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Your question' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Needs a question mark at the end.');
    expect(screen.queryByText(HELPER)).not.toBeInTheDocument();
    expect(screen.queryByText('16/90')).not.toBeInTheDocument();
  });

  it('clears the error wiring when the error goes away', () => {
    const { rerender } = render(<Field label="Your question" helper={HELPER} error="Too short." />);
    rerender(<Field label="Your question" helper={HELPER} error={null} />);
    const input = screen.getByRole('textbox');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription(HELPER);
  });

  it('keeps an outside aria-describedby', () => {
    render(
      <>
        <p id="rules">Rules apply.</p>
        <Field label="Your question" helper={HELPER} aria-describedby="rules" />
      </>,
    );
    expect(screen.getByRole('textbox')).toHaveAccessibleDescription(`Rules apply. ${HELPER}`);
  });

  it('uses a given id for the label', () => {
    render(<Field id="question" label="Your question" />);
    expect(screen.getByLabelText('Your question')).toHaveAttribute('id', 'question');
  });

  it('is not focusable when disabled', async () => {
    const user = userEvent.setup();
    render(<Field label="Your question" disabled />);
    await user.tab();
    expect(screen.getByRole('textbox')).not.toHaveFocus();
  });
});
