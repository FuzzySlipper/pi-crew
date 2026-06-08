import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEventBus } from "./fake-event-bus.js";
import type { EventBus, GatewayEvent } from "../events.js";

describe("FakeEventBus", () => {
  let bus: FakeEventBus;

  beforeEach(() => {
    bus = new FakeEventBus();
  });

  it("satisfies the EventBus interface", () => {
    const b: EventBus = bus;
    expect(b).toBe(bus);
  });

  // ── emit & capture ────────────────────────────────────────

  it("captures emitted events in order", () => {
    const e1: GatewayEvent = {
      event: "session.created",
      payload: { sessionId: "s1", kind: "conversational" },
    };
    const e2: GatewayEvent = {
      event: "session.expired",
      payload: { sessionId: "s1", reason: "timeout" },
    };

    bus.emit(e1);
    bus.emit(e2);

    expect(bus.emitted).toHaveLength(2);
    expect(bus.emitted[0]).toEqual(e1);
    expect(bus.emitted[1]).toEqual(e2);
  });

  it("records every dot-style event type", () => {
    const events: GatewayEvent[] = [
      { event: "tool.called", payload: { toolName: "x", sessionId: "s" } },
      {
        event: "tool.completed",
        payload: {
          toolName: "x",
          sessionId: "s",
          success: true,
          durationMs: 5,
        },
      },
      {
        event: "turn.started",
        payload: { sessionId: "s", turnNumber: 1 },
      },
      {
        event: "turn.completed",
        payload: { sessionId: "s", turnNumber: 1, durationMs: 10 },
      },
      {
        event: "turn.errored",
        payload: { sessionId: "s", turnNumber: 2, error: "boom" },
      },
      {
        event: "turn.exhausted",
        payload: { sessionId: "s", turnNumber: 3, reason: "token_limit" },
      },
      {
        event: "checkpoint.waiting",
        payload: {
          workerIdentity: "w",
          assignmentId: 1,
          checkpointId: 1,
        },
      },
      {
        event: "context.pressure",
        payload: { sessionId: "s", usedTokens: 900, maxTokens: 1000 },
      },
      {
        event: "worker.stuck",
        payload: {
          workerIdentity: "w",
          assignmentId: 1,
          reason: "no_tools",
          lastActivityAt: "2026-06-08T12:00:00.000Z",
          lastLifecycleState: "executing",
          idleTimeoutMs: 60000,
          remediationRequired: true,
        },
      },
      {
        event: "gateway.shutdown",
        payload: { reason: "SIGTERM" },
      },
      {
        event: "assignment.claimed",
        payload: { assignmentId: 1, workerIdentity: "w", taskId: 42 },
      },
      {
        event: "assignment.released",
        payload: { assignmentId: 1, workerIdentity: "w", reason: "done" },
      },
      {
        event: "blackboard.written",
        payload: { entryId: "bb1", sessionId: "s" },
      },
    ];

    for (const ev of events) {
      bus.emit(ev);
    }

    expect(bus.emitted).toHaveLength(events.length);
  });

  // ── subscribe / on ────────────────────────────────────────

  it("calls registered handler when matching event is emitted", () => {
    const handler = vi.fn();

    bus.on("session.created", handler);
    bus.emit({
      event: "session.created",
      payload: { sessionId: "s1", kind: "worker" },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      sessionId: "s1",
      kind: "worker",
    });
  });

  it("does NOT call handler for different event name", () => {
    const handler = vi.fn();

    bus.on("session.created", handler);
    bus.emit({
      event: "session.expired",
      payload: { sessionId: "s1", reason: "done" },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("on returns an unsubscribe function", () => {
    const handler = vi.fn();

    const unsub = bus.on("session.created", handler);
    unsub();

    bus.emit({
      event: "session.created",
      payload: { sessionId: "s1", kind: "conversational" },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("off removes a specific handler", () => {
    const handler = vi.fn();

    bus.on("session.created", handler);
    bus.off("session.created", handler);

    bus.emit({
      event: "session.created",
      payload: { sessionId: "s1", kind: "conversational" },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple handlers for the same event", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("tool.called", h1);
    bus.on("tool.called", h2);

    bus.emit({
      event: "tool.called",
      payload: { toolName: "search", sessionId: "s" },
    });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing one handler does not affect others", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("tool.called", h1);
    bus.on("tool.called", h2);

    bus.off("tool.called", h1);

    bus.emit({
      event: "tool.called",
      payload: { toolName: "search", sessionId: "s" },
    });

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  // ── clear ─────────────────────────────────────────────────

  it("clear removes all captured events and handlers", () => {
    const handler = vi.fn();
    bus.on("session.created", handler);

    bus.emit({
      event: "session.created",
      payload: { sessionId: "s1", kind: "conversational" },
    });
    expect(bus.emitted).toHaveLength(1);

    bus.clear();
    expect(bus.emitted).toHaveLength(0);

    // Handlers are also cleared — re-emitting should not fire them.
    bus.emit({
      event: "session.created",
      payload: { sessionId: "s2", kind: "worker" },
    });
    expect(handler).toHaveBeenCalledTimes(1); // only the pre-clear call
  });
});
