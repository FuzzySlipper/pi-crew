import { describe, it, expect, beforeEach } from "vitest";
import { SpyEventBus } from "./spy-event-bus.js";
import type { EventBus, GatewayEvent } from "../events.js";

describe("SpyEventBus", () => {
  let bus: SpyEventBus;

  beforeEach(() => {
    bus = new SpyEventBus();
  });

  it("satisfies the EventBus interface", () => {
    const eventBus: EventBus = bus;
    expect(eventBus).toBe(bus);
  });

  it("records sequence numbers and timestamps in emission order", () => {
    const first: GatewayEvent = {
      event: "session.created",
      payload: { sessionId: "s1", kind: "worker" },
    };
    const second: GatewayEvent = {
      event: "turn.started",
      payload: { sessionId: "s1", turnNumber: 1 },
    };

    bus.emit(first);
    bus.emit(second);

    expect(bus.records).toHaveLength(2);
    expect(bus.records[0]?.sequence).toBe(1);
    expect(bus.records[1]?.sequence).toBe(2);
    expect(bus.records[0]?.event).toEqual(first);
    expect(bus.records[1]?.event).toEqual(second);
    expect(bus.records[0]?.timestamp).toBeInstanceOf(Date);
    expect(bus.records[1]?.timestamp.getTime()).toBeGreaterThanOrEqual(
      bus.records[0]?.timestamp.getTime() ?? 0,
    );
  });

  it("routes handlers and exposes emitted event parity", () => {
    const seen: string[] = [];
    bus.on("tool.called", (payload) => {
      seen.push(payload.toolName);
    });

    bus.emit({
      event: "tool.called",
      payload: { toolName: "context_status", sessionId: "s1" },
    });

    expect(seen).toEqual(["context_status"]);
    expect(bus.emitted).toHaveLength(1);
    expect(bus.emitted[0]?.event).toBe("tool.called");
  });

  it("clear removes records and handlers", () => {
    const seen: string[] = [];
    bus.on("session.expired", (payload) => {
      seen.push(payload.sessionId);
    });
    bus.emit({
      event: "session.expired",
      payload: { sessionId: "s1", reason: "test" },
    });

    bus.clear();
    bus.emit({
      event: "session.expired",
      payload: { sessionId: "s2", reason: "test" },
    });

    expect(bus.records).toHaveLength(1);
    expect(bus.records[0]?.sequence).toBe(1);
    expect(seen).toEqual(["s1"]);
  });
});
