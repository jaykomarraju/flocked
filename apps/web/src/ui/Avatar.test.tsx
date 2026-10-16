import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, avatarInitial } from './Avatar';

describe('avatarInitial', () => {
  it('is the first letter of the handle, upper case, without the @', () => {
    expect(avatarInitial('woolgatherer')).toBe('W');
    expect(avatarInitial('@baa_humbug')).toBe('B');
    expect(avatarInitial('élan')).toBe('É');
    expect(avatarInitial('')).toBe('?');
  });
});

describe('Avatar', () => {
  it('falls back to the initial and is decorative without alt text', () => {
    const { container } = render(<Avatar handle="jay" size={40} />);
    const avatar = container.firstElementChild!;
    expect(avatar).toHaveTextContent('J');
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('names the initial fallback when given alt text', () => {
    render(<Avatar handle="jay" size={64} alt="@jay" />);
    expect(screen.getByRole('img', { name: '@jay' })).toHaveTextContent('J');
  });

  it('shows the profile picture with its alt text', () => {
    render(<Avatar handle="jay" size={32} src="https://example.com/jay.png" alt="@jay" />);
    const img = screen.getByRole('img', { name: '@jay' });
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', 'https://example.com/jay.png');
    expect(img).toHaveAttribute('width', '32');
  });

  it('keeps a decorative picture out of the accessibility tree', () => {
    const { container } = render(
      <Avatar handle="jay" size={24} src="https://example.com/jay.png" />,
    );
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('falls back to the initial when the picture fails to load', () => {
    const { container } = render(
      <Avatar handle="ewe_turn" size={40} src="https://example.com/broken.png" alt="@ewe_turn" />,
    );
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '@ewe_turn' })).toHaveTextContent('E');
  });
});
