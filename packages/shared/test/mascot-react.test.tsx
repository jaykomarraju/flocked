// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MASCOT_POSE_NAMES } from '../src/index';
import { Mascot } from '../src/mascot/react';

afterEach(cleanup);

/**
 * The few DOM members these tests read. The package compiles without the DOM lib (the API Worker
 * imports it), so the test views jsdom's nodes through this instead.
 */
interface El {
  tagName: string;
  innerHTML: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
}

const el = (node: unknown) => node as El;

describe('Mascot', () => {
  it.each(MASCOT_POSE_NAMES)('renders %s with an accessible name from its title', (pose) => {
    render(<Mascot pose={pose} size={176} title={`The sheep, ${pose}`} />);
    const img = el(screen.getByRole('img', { name: `The sheep, ${pose}` }));
    expect(img.tagName.toLowerCase()).toBe('svg');
    expect(img.getAttribute('aria-hidden')).toBeNull();
    expect(img.getAttribute('data-pose')).toBe(pose);
  });

  it('is decorative without a title', () => {
    const { container } = render(<Mascot pose="neutral" size={176} />);
    expect(screen.queryByRole('img')).toBeNull();
    const svg = el(container).querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.querySelector('title')).toBeNull();
  });

  it('sizes by width and keeps the aspect ratio', () => {
    const { container } = render(<Mascot pose="neutral" size={176} className="sheep" />);
    const svg = el(container).querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('176');
    expect(svg?.getAttribute('height')).toBe('154');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 160 140');
    expect(svg?.getAttribute('class')).toBe('sheep');
  });

  it('keeps the ink outline and white wool fixed, and themes the limbs and the glint', () => {
    const { container } = render(<Mascot pose="smug" size={176} />);
    const root = el(container);
    const fills = Array.from(root.querySelectorAll('circle')).map((c) => c.getAttribute('fill'));
    expect(fills).toContain('#141414');
    expect(fills).toContain('#FFFFFF');
    const legs = root.querySelector('path[d^="M68 100"]');
    expect(legs?.getAttribute('style')).toContain('var(--color-ink)');
    expect(legs?.getAttribute('stroke')).toBeNull();
    const glint = root.querySelector('path[d="M14 22v12M8 28h12"]');
    expect(glint?.getAttribute('style')).toContain('var(--color-accent)');
    expect(root.innerHTML).not.toMatch(/#FF4F2E|#FF5A3A|#F5F2EC/i);
  });

  it('draws the flock as five sheep', () => {
    const { container } = render(<Mascot pose="flock" size={560} />);
    const svg = el(container).querySelector('svg');
    expect(svg?.getAttribute('height')).toBe('180');
    expect(svg?.querySelectorAll(':scope > svg')).toHaveLength(5);
  });
});
