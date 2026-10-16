// External services moderation depends on: the rubric model (Claude, ./claude.ts) and the duplicate
// index (Workers AI embeddings + Vectorize, ./duplicates.ts). `moderationDeps(env)` builds the real
// ones; tests register fakes for one env object with `withModerationDeps`, so production never falls
// back to a fake (plan 2.6). Same pattern as src/personhood/deps.ts.
import { claudeModel } from './claude.js';
import { duplicateIndex } from './duplicates.js';
import type { ModerationDeps, ModerationEnv } from './types.js';

const overrides = new WeakMap<object, Partial<ModerationDeps>>();

/**
 * Test hook: registers fake moderation dependencies for this env object and returns it (the rest
 * stay real). It registers in place rather than copying, so it composes with the other deps hooks.
 */
export function withModerationDeps<E extends object>(env: E, deps: Partial<ModerationDeps>): E {
  overrides.set(env, { ...overrides.get(env), ...deps });
  return env;
}

export function moderationDeps(env: ModerationEnv): ModerationDeps {
  const o = overrides.get(env) ?? {};
  return {
    model: o.model ?? claudeModel(env),
    duplicates: o.duplicates ?? duplicateIndex(env),
  };
}
