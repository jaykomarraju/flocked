// The handler registry: (eventName) → handlers (wave-4 pinned interface; the default instance and the
// built-in registrations live in handlers.ts). Each handler has a name that is unique for its event,
// because chain_event_handled records (event, revision, handler) once that handler has run.
import type { EventHandler } from './types.js';

/** Registered under this event name, a handler sees every event (before the event's own handlers). */
export const ANY_EVENT = '*';

export interface HandlerOptions {
  /**
   * The handler doesn't depend on event order (ALERT-8). While an earlier entry's dispatch keeps
   * failing it still sees the additions behind it, so one broken handler can't silence it.
   */
  independent?: boolean;
}

export interface RegisteredHandler {
  event: string;
  name: string;
  fn: EventHandler;
  independent: boolean;
}

export class HandlerRegistry {
  private readonly byEvent = new Map<string, RegisteredHandler[]>();

  /** @throws when `name` already runs for `event` (registered for it, or for every event). */
  register(event: string, name: string, fn: EventHandler, opts: HandlerOptions = {}): void {
    if (event === '' || name === '') throw new Error('handler event and name must be non-empty');
    const list = this.byEvent.get(event) ?? [];
    const clash =
      event === ANY_EVENT
        ? this.list().some((h) => h.name === name)
        : this.for(event).some((h) => h.name === name);
    if (clash) throw new Error(`handler ${name} is already registered for ${event}`);
    list.push({ event, name, fn, independent: opts.independent === true });
    this.byEvent.set(event, list);
  }

  /** The handlers for one event, in run order: ANY_EVENT handlers first, then the event's own. */
  for(event: string): RegisteredHandler[] {
    return [...(this.byEvent.get(ANY_EVENT) ?? []), ...(this.byEvent.get(event) ?? [])];
  }

  /** Every registered handler, by event. */
  list(): RegisteredHandler[] {
    return [...this.byEvent.values()].flat();
  }
}
