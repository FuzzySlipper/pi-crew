/**
 * Timestamped {@link EventBus} test fake for ordering-sensitive tests.
 *
 * Use {@link FakeEventBus} for ordinary unit tests. Use this spy when a
 * test needs durable evidence about emission order and wall-clock timing.
 *
 * @module pi-core/test-helpers/spy-event-bus
 */

import type { EventBus, GatewayEvent, EventPayload } from "../events.js";

/** A timestamped event capture record. */
export interface SpyEventRecord {
  /** Monotonic emission sequence number, starting at 1. */
  readonly sequence: number;
  /** Wall-clock timestamp captured at emission time. */
  readonly timestamp: Date;
  /** Captured gateway event. */
  readonly event: GatewayEvent;
}

/**
 * In-memory {@link EventBus} that records event order and timestamps.
 */
export class SpyEventBus implements EventBus {
  /** Timestamped event records in emission order. */
  public readonly records: SpyEventRecord[] = [];

  private nextSequence = 1;
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  emit(event: GatewayEvent): void {
    this.records.push({
      sequence: this.nextSequence,
      timestamp: new Date(),
      event,
    });
    this.nextSequence += 1;

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
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)?.add(handler as (payload: unknown) => void);
    return () => {
      this.off(event, handler);
    };
  }

  off<E extends GatewayEvent["event"]>(
    event: E,
    handler: (payload: EventPayload<E>) => void,
  ): void {
    this.handlers.get(event)?.delete(handler as (payload: unknown) => void);
  }

  /** Events without timestamps, useful for parity with {@link FakeEventBus}. */
  get emitted(): GatewayEvent[] {
    return this.records.map((record) => record.event);
  }

  /** Remove all captured records and handler registrations. */
  clear(): void {
    this.records.length = 0;
    this.handlers.clear();
    this.nextSequence = 1;
  }
}
