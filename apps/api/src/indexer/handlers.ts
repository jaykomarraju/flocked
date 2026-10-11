// The indexer's handler registry (wave-4 pinned interface): (eventName) → handler(evt, env). The
// dispatcher (dispatch.ts) calls each registered handler once per event revision, in chain order.
//
// Built in (W4-B): ALERT-8 for every role-only event the backend didn't send, and the foreign-entry
// path for `Entered`. Lifecycle handlers (proposal, veto, refund, finalize; Stakes ingestion) register
// themselves from their own modules with registerHandler (W4-D, W6-A), imported before the first poll.
import { foreignEntryHandler } from './entered.js';
import { unsentTxHandler } from './policy.js';
import { ANY_EVENT, HandlerRegistry } from './registry.js';
import type { EventHandler } from './types.js';

export { ANY_EVENT, HandlerRegistry, type RegisteredHandler } from './registry.js';

/** Registers the W4-B handlers on `registry`. */
export function registerBuiltinHandlers(registry: HandlerRegistry): HandlerRegistry {
  registry.register(ANY_EVENT, 'alert-unsent-tx', unsentTxHandler);
  registry.register('Entered', 'foreign-entry', foreignEntryHandler);
  return registry;
}

/** The registry IndexerDO dispatches through. */
export const handlers: HandlerRegistry = registerBuiltinHandlers(new HandlerRegistry());

/**
 * Registers a handler for `event` (an ABI event name, or ANY_EVENT). `name` identifies the handler in
 * chain_event_handled, so keep it stable across deploys: renaming it re-runs the handler on events
 * still pending.
 */
export function registerHandler(event: string, name: string, fn: EventHandler): void {
  handlers.register(event, name, fn);
}
