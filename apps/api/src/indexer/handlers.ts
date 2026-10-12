// The indexer's handler registry (wave-4 pinned interface): (eventName) → handler(evt, env). The
// dispatcher (dispatch.ts) calls each registered handler once per event revision, in chain order.
//
// Built in (W4-B): ALERT-8 for every role-only event the backend didn't send, and the foreign-entry
// path for `Entered`. W4-D's lifecycle handlers (src/lifecycle/handlers.ts: Stakes entry counters,
// Locked/Committed confirmations, the guardian void) are registered on the default registry below;
// W6-A adds proposal, veto, refund and finalize the same way, and W6-D the claims (src/read/claimed.ts).
import { registerLifecycleHandlers } from '../lifecycle/handlers.js';
import { registerClaimHandlers } from '../read/claimed.js';
import { foreignEntryHandler } from './entered.js';
import { unsentTxHandler } from './policy.js';
import { ANY_EVENT, HandlerRegistry, type HandlerOptions } from './registry.js';
import type { EventHandler } from './types.js';

export {
  ANY_EVENT,
  HandlerRegistry,
  type HandlerOptions,
  type RegisteredHandler,
} from './registry.js';

/** Registers the W4-B handlers on `registry`. ALERT-8 runs even past a stuck entry (independent). */
export function registerBuiltinHandlers(registry: HandlerRegistry): HandlerRegistry {
  registry.register(ANY_EVENT, 'alert-unsent-tx', unsentTxHandler, { independent: true });
  registry.register('Entered', 'foreign-entry', foreignEntryHandler);
  return registry;
}

/** The registry IndexerDO dispatches through: the built-in handlers, the lifecycle ones, the claims. */
export const handlers: HandlerRegistry = registerClaimHandlers(
  registerLifecycleHandlers(registerBuiltinHandlers(new HandlerRegistry())),
);

/**
 * Registers a handler for `event` (an ABI event name, or ANY_EVENT). `name` identifies the handler in
 * chain_event_handled, so keep it stable across deploys: renaming it re-runs the handler on events
 * still pending.
 */
export function registerHandler(
  event: string,
  name: string,
  fn: EventHandler,
  opts?: HandlerOptions,
): void {
  handlers.register(event, name, fn, opts);
}
