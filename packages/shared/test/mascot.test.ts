import { describe, expect, it } from 'vitest';

import {
  MASCOT_COLOR_ROLES,
  MASCOT_OUTLINE,
  MASCOT_POSE_NAMES,
  MASCOT_POSES,
  MASCOT_WOOL,
  mascotColor,
  mascotSize,
  mascotSvg,
  type MascotColorRole,
  type MascotPose,
  type MascotShape,
} from '../src/index';

/** Every drawn shape (paths, circles, ellipses), with groups and nested viewports flattened. */
function drawn(
  shapes: readonly MascotShape[],
): Exclude<MascotShape, { kind: 'group' } | { kind: 'svg' }>[] {
  return shapes.flatMap((s) => (s.kind === 'group' || s.kind === 'svg' ? drawn(s.children) : [s]));
}

function roles(pose: MascotPose): Set<MascotColorRole> {
  const out = new Set<MascotColorRole>();
  for (const s of drawn(MASCOT_POSES[pose].shapes)) {
    if (s.fill) out.add(s.fill);
    if (s.stroke) out.add(s.stroke);
  }
  return out;
}

const COLORS = { limb: '#F5F2EC', accent: '#FF5A3A' };

describe('mascot poses (Design_Language.md "Mascot")', () => {
  it('has the five poses Paper draws', () => {
    expect(MASCOT_POSE_NAMES).toEqual(['neutral', 'smug', 'walking-away', 'shocked', 'flock']);
    expect(Object.keys(MASCOT_POSES).sort()).toEqual([...MASCOT_POSE_NAMES].sort());
  });

  it('draws single sheep in a 160×140 viewBox and the flock in 560×180', () => {
    for (const pose of ['neutral', 'smug', 'walking-away', 'shocked'] as const) {
      expect(MASCOT_POSES[pose].viewBox).toEqual([0, 0, 160, 140]);
    }
    expect(MASCOT_POSES.flock.viewBox).toEqual([0, 0, 560, 180]);
  });

  it('keeps to ink and white, plus the accent on the smug glint only', () => {
    for (const pose of MASCOT_POSE_NAMES) {
      const used = roles(pose);
      expect(used.has('outline')).toBe(true);
      expect(used.has('wool')).toBe(true);
      expect(used.has('limb')).toBe(true);
      expect(used.has('accent')).toBe(pose === 'smug');
    }
  });

  it('tags every paint with a known role, and strokes carry a width', () => {
    for (const pose of MASCOT_POSE_NAMES) {
      for (const s of drawn(MASCOT_POSES[pose].shapes)) {
        expect(s.fill ?? s.stroke).toBeDefined();
        if (s.fill) expect(MASCOT_COLOR_ROLES).toContain(s.fill);
        if (s.stroke) {
          expect(MASCOT_COLOR_ROLES).toContain(s.stroke);
          expect(s.strokeWidth).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never fills or outlines the wool with a theme colour (limbs are strokes only)', () => {
    for (const pose of MASCOT_POSE_NAMES) {
      for (const s of drawn(MASCOT_POSES[pose].shapes)) {
        if (s.fill === 'limb' || s.fill === 'accent') throw new Error(`${pose}: themed fill`);
        if (s.stroke === 'limb' || s.stroke === 'accent') expect(s.kind).toBe('path');
      }
    }
  });

  it('builds the flock from five identical neutral sheep', () => {
    const sheep = MASCOT_POSES.flock.shapes;
    expect(sheep).toHaveLength(5);
    for (const s of sheep) {
      expect(s.kind).toBe('svg');
      if (s.kind === 'svg') expect(s.children).toBe(MASCOT_POSES.neutral.shapes);
    }
  });

  it('fixes the outline and wool colours in both themes', () => {
    expect(MASCOT_OUTLINE).toBe('#141414');
    expect(MASCOT_WOOL).toBe('#FFFFFF');
    expect(mascotColor('outline', COLORS)).toBe('#141414');
    expect(mascotColor('wool', COLORS)).toBe('#FFFFFF');
    expect(mascotColor('limb', COLORS)).toBe('#F5F2EC');
    expect(mascotColor('accent', COLORS)).toBe('#FF5A3A');
  });

  it('sizes a pose by width, keeping its aspect ratio', () => {
    expect(mascotSize('neutral', 176)).toEqual({ width: 176, height: 154 });
    expect(mascotSize('flock', 280)).toEqual({ width: 280, height: 90 });
    expect(() => mascotSize('neutral', 0)).toThrow(RangeError);
    expect(() => mascotSize('neutral', Number.NaN)).toThrow(RangeError);
  });
});

describe('mascotSvg', () => {
  /** Tags in order, checking each opened element is closed in order (well-formed XML). */
  function checkWellFormed(svg: string): string[] {
    const stack: string[] = [];
    const tags: string[] = [];
    for (const m of svg.matchAll(/<(\/?)([a-z]+)((?:\s+[a-zA-Z:-]+="[^"<>]*")*)\s*(\/?)>/g)) {
      const [, close, name = '', , selfClose] = m;
      if (close) expect(stack.pop()).toBe(name);
      else {
        tags.push(name);
        if (!selfClose) stack.push(name);
      }
    }
    expect(stack).toEqual([]);
    // Nothing outside the tags: the whole string is markup.
    expect(svg.replace(/<[^>]+>/g, '')).toBe('');
    return tags;
  }

  it.each(MASCOT_POSE_NAMES)('renders %s as a well-formed SVG document', (pose) => {
    const svg = mascotSvg(pose, COLORS);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ')).toBe(true);
    const tags = checkWellFormed(svg);
    expect(tags[0]).toBe('svg');
    expect(tags.filter((t) => t === 'path' || t === 'circle' || t === 'ellipse').length).toBe(
      drawn(MASCOT_POSES[pose].shapes).length,
    );
  });

  it('paints with the fixed outline and wool and the given limb and accent', () => {
    const svg = mascotSvg('smug', { limb: '#123456', accent: '#ABCDEF' });
    expect(svg).toContain('fill="#141414"');
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain('stroke="#141414"');
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain('stroke="#ABCDEF"');
    expect(mascotSvg('neutral', { limb: '#123456', accent: '#ABCDEF' })).not.toContain('#ABCDEF');
  });

  it('draws shock and motion lines in the limb colour', () => {
    const shocked = mascotSvg('shocked', { limb: '#123456', accent: '#ABCDEF' });
    expect(shocked).toContain(
      '<path d="M14 30l6 8M40 22v10M66 30l-6 8" fill="none" stroke="#123456" stroke-width="4" stroke-linecap="round"/>',
    );
    const walking = mascotSvg('walking-away', { limb: '#123456', accent: '#ABCDEF' });
    expect(walking).toContain('<path d="M4 66h14M0 82h16M6 98h12" fill="none" stroke="#123456"');
  });

  it('sizes the document by width', () => {
    expect(mascotSvg('neutral', { ...COLORS, size: 176 })).toContain('width="176" height="154"');
    expect(mascotSvg('neutral', COLORS)).toContain('width="160" height="140"');
    expect(mascotSvg('flock', { ...COLORS, size: 100 })).toContain('width="100" height="32.143"');
  });

  it('escapes colour values', () => {
    const svg = mascotSvg('neutral', { limb: '"><script>', accent: 'x' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('stroke="&quot;&gt;&lt;script&gt;"');
  });
});
