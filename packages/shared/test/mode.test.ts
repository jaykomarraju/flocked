import type { Mode as SettleMode } from '@flocked/settle';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { MODES, type Mode } from '../src/index';

// @flocked/settle keeps its own `Mode` so it stays dependency-free (W1-Z); this pins the two together.
describe('Mode matches @flocked/settle', () => {
  it('is the same type in both packages', () => {
    expectTypeOf<Mode>().toEqualTypeOf<SettleMode>();
  });

  it('lists exactly the settle modes', () => {
    const settleModes = { free: true, stakes: true } satisfies Record<SettleMode, true>;
    expect([...MODES].sort()).toEqual(Object.keys(settleModes).sort());
  });
});
