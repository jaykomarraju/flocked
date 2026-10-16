import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SignInPanel, codeDigits, type SignInPanelProps } from './SignInPanel';

describe('SignInPanel', () => {
  it('choose: the three providers and the note that email cannot make an account', async () => {
    const onFarcaster = vi.fn();
    const onWallet = vi.fn();
    const onChooseEmail = vi.fn();
    render(
      <SignInPanel
        step="choose"
        onFarcaster={onFarcaster}
        onWallet={onWallet}
        onChooseEmail={onChooseEmail}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Sign in to Flocked' })).toBeInTheDocument();
    expect(screen.getByText('Pick one. You can link the others later.')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Email works once it's linked to an account. New here? Start with Farcaster or a wallet.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Farcaster' }));
    await userEvent.click(screen.getByRole('button', { name: 'Connect a wallet' }));
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(onFarcaster).toHaveBeenCalledOnce();
    expect(onWallet).toHaveBeenCalledOnce();
    expect(onChooseEmail).toHaveBeenCalledOnce();
  });

  it('choose: a pending provider is busy and the others wait', async () => {
    const onFarcaster = vi.fn();
    render(<SignInPanel step="choose" pending="wallet" onFarcaster={onFarcaster} />);
    expect(screen.getByRole('button', { name: 'Connect a wallet' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Farcaster' }));
    expect(onFarcaster).not.toHaveBeenCalled();
  });

  it('mini-app: continues as the Farcaster account, with the wallet as the fallback', async () => {
    const onFarcaster = vi.fn();
    const onWallet = vi.fn();
    render(
      <SignInPanel
        step="mini-app"
        account={{ username: 'jay' }}
        onFarcaster={onFarcaster}
        onWallet={onWallet}
      />,
    );
    expect(screen.getByRole('heading', { name: "You're in Farcaster" })).toBeInTheDocument();
    expect(screen.getByText('@jay')).toBeInTheDocument();
    expect(screen.getByText('Farcaster account')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue as @jay' }));
    await userEvent.click(screen.getByRole('button', { name: 'Use a wallet instead' }));
    expect(onFarcaster).toHaveBeenCalledOnce();
    expect(onWallet).toHaveBeenCalledOnce();
  });

  it('mini-app: without a username it continues with Farcaster', () => {
    render(<SignInPanel step="mini-app" account={{ displayName: 'Jay' }} />);
    expect(screen.getByRole('button', { name: 'Continue with Farcaster' })).toBeInTheDocument();
  });

  it('email: an Email field, submit on Enter, and Not now', async () => {
    const onSubmitEmail = vi.fn();
    const onClose = vi.fn();
    function Harness() {
      const [email, setEmail] = useState('');
      return (
        <SignInPanel
          step="email"
          email={email}
          onEmailChange={setEmail}
          onSubmitEmail={onSubmitEmail}
          onClose={onClose}
        />
      );
    }
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: 'Email' });
    expect(field).toHaveAttribute('type', 'email');
    expect(field).toHaveAttribute('autocomplete', 'email');
    await userEvent.type(field, 'wool@flocked.test{Enter}');
    expect(field).toHaveValue('wool@flocked.test');
    expect(onSubmitEmail).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("email: the field's own error marks it invalid", () => {
    render(<SignInPanel step="email" email="wool" fieldError="Not an address." />);
    const field = screen.getByRole('textbox', { name: 'Email' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Not an address.');
  });

  it("code: the API's 8 digits and 5 minutes, digits only, a one-time-code field", async () => {
    const onSubmitCode = vi.fn();
    function Harness() {
      const [code, setCode] = useState('');
      return (
        <SignInPanel
          step="code"
          email="wool@flocked.test"
          code={code}
          onCodeChange={setCode}
          onSubmitCode={onSubmitCode}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(
      screen.getByText('We sent an 8-digit code to wool@flocked.test. It works for 5 minutes.'),
    ).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Code' });
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await userEvent.type(field, '12a34-5678 99');
    expect(field).toHaveValue('12345678');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSubmitCode).toHaveBeenCalledOnce();
  });

  it("code: Paper's example (6 digits, 10 minutes) through the props", () => {
    render(<SignInPanel step="code" email="jay@example.com" codeLength={6} codeMinutes={10} />);
    expect(
      screen.getByText('We sent a 6-digit code to jay@example.com. It works for 10 minutes.'),
    ).toBeInTheDocument();
  });

  it('code: the error box and the resend', async () => {
    const onResend = vi.fn();
    const { rerender } = render(
      <SignInPanel
        step="code"
        email="wool@flocked.test"
        code="12345678"
        error="Wrong code; 4 attempts left"
        onResend={onResend}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong code; 4 attempts left');
    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveValue('12345678');
    expect(screen.getByText(/Nothing yet\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send a new code.' }));
    expect(onResend).toHaveBeenCalledOnce();
    rerender(<SignInPanel step="code" email="wool@flocked.test" resent onResend={onResend} />);
    expect(screen.getByText(/A new code is on its way\./)).toBeInTheDocument();
  });

  it('farcaster-wait: the approval link, the wait, and cancel', async () => {
    const onCancelFarcaster = vi.fn();
    render(
      <SignInPanel
        step="farcaster-wait"
        approvalUrl="https://farcaster.xyz/~/siwf?channelToken=abc"
        onCancelFarcaster={onCancelFarcaster}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Approve in Farcaster' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open Farcaster' });
    expect(link).toHaveAttribute('href', 'https://farcaster.xyz/~/siwf?channelToken=abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for your approval');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelFarcaster).toHaveBeenCalledOnce();
  });

  it('a new step moves focus to its field', () => {
    const props: SignInPanelProps = { step: 'choose' };
    const { rerender } = render(<SignInPanel {...props} />);
    expect(document.body).toHaveFocus();
    rerender(<SignInPanel step="email" />);
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
    rerender(<SignInPanel step="code" email="wool@flocked.test" />);
    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveFocus();
  });
});

describe('codeDigits', () => {
  it('keeps digits, up to the length', () => {
    expect(codeDigits(' 1234-5678 ', 8)).toBe('12345678');
    expect(codeDigits('123456789', 8)).toBe('12345678');
    expect(codeDigits('abc', 8)).toBe('');
  });
});
