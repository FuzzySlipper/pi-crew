/**
 * In-memory {@link EventBus} fake for testing.
 *
 * Captures every emitted event in order so tests can assert on
 * event history, and correctly routes dot-style events to registered
 * handlers.
 *
 * @module pi-core/test-helpers/fake-event-bus
 */

import type { EventBus, GatewayEvent, EventPayload } from "../events.js";

/**
 * In-memory {@link EventBus} that records all emitted events and
 * dispatches to registered listeners.
 */
export class FakeEventBus implements EventBus {
  /** Every event emitted, in chronological order. */
  public readonly emitted: GatewayEvent[] = [];

  private readonly handlers = new Map<
    string,
    Set<(payload: unknown) => void>
  >();

  // ── EventBus contract ──────────────────────────────────────────

  emit(event: GatewayEvent): void {
    this.emitted.push(event);
    const subs = this.handlers.get(event.event);
    if (subs) {
      for (const handler of subs) {
        handler(event.payload);
      }
    }
  }

  on<E extends GatewayEvent["event"]>(
    event: E,
    handler: (payload: EventPayload<E>) => void,
  ): () => void {
    const key = event as string;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    const subs = this.handlers.get(key);
    if (subs) {
      subs.add(handler as (payload: unknown) => void);
    }
    return () => {
      this.off(event, handler);
    };
  }

  off<E extends GatewayEvent["event"]>(
    event: E,
    handler: (payload: EventPayload<E>) => void,
  ): void {
    const subs = this.handlers.get(event);
    if (subs) {
      subs.delete(handler);
    }
  }

  // ── Test helpers ───────────────────────────────────────────────

  /** Remove all captured events and handler registrations. */
  clear(): void {
    this.emitted.length = 0;
    this.handlers.clear();
  }
}
