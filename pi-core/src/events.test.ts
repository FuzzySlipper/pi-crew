import { describe, it, expect } from "vitest";
import type {
  GatewayEvent,
  EventPayload,
} from "./events.js";

describe("GatewayEvent union — dot-style names", () => {
  it("accepts 'session.created' event", () => {
    const ev: GatewayEvent = {
      event: "session.created",
      payload: { sessionId: "s1", kind: "conversational" },
    };
    expect(ev.event).toBe("session.created");
    expect(ev.payload.sessionId).toBe("s1");
  });

  it("accepts 'session.expired' event", () => {
    const ev: GatewayEvent = {
      event: "session.expired",
      payload: { sessionId: "s1", reason: "timeout" },
    };
    expect(ev.event).toBe("session.expired");
  });

  it("accepts 'tool.called' event", () => {
    const ev: GatewayEvent = {
      event: "tool.called",
      payload: { toolName: "search", sessionId: "s1" },
    };
    expect(ev.event).toBe("tool.called");
  });

  it("accepts 'tool.completed' event", () => {
    const ev: GatewayEvent = {
      event: "tool.completed",
      payload: {
        toolName: "search",
        sessionId: "s1",
        success: true,
        durationMs: 42,
      },
    };
    expect(ev.event).toBe("tool.completed");
    expect(ev.payload.success).toBe(true);
  });

  it("accepts 'blackboard.written' event", () => {
    const ev: GatewayEvent = {
      event: "blackboard.written",
      payload: { entryId: "bb1", sessionId: "s1" },
    };
    expect(ev.event).toBe("blackboard.written");
  });

  it("accepts 'assignment.claimed' event", () => {
    const ev: GatewayEvent = {
      event: "assignment.claimed",
      payload: {
        assignmentId: 1,
        workerIdentity: "pi-w",
        taskId: 42,
      },
    };
    expect(ev.event).toBe("assignment.claimed");
    expect(ev.payload.assignmentId).toBe(1);
    expect(ev.payload.workerIdentity).toBe("pi-w");
    expect(ev.payload.taskId).toBe(42);
  });

  it("accepts 'assignment.released' event", () => {
    const ev: GatewayEvent = {
      event: "assignment.released",
      payload: {
        assignmentId: 1,
        workerIdentity: "pi-w",
        reason: "completed",
      },
    };
    expect(ev.event).toBe("assignment.released");
  });

  it("accepts 'turn.started' event", () => {
    const ev: GatewayEvent = {
      event: "turn.started",
      payload: { sessionId: "s1", turnNumber: 3 },
    };
    expect(ev.event).toBe("turn.started");
  });

  it("accepts 'turn.completed' event", () => {
    const ev: GatewayEvent = {
      event: "turn.completed",
      payload: { sessionId: "s1", turnNumber: 3, durationMs: 123 },
    };
    expect(ev.event).toBe("turn.completed");
  });

  it("accepts 'turn.errored' event", () => {
    const ev: GatewayEvent = {
      event: "turn.errored",
      payload: { sessionId: "s1", turnNumber: 3, error: "timeout" },
    };
    expect(ev.event).toBe("turn.errored");
  });

  it("accepts 'turn.exhausted' event", () => {
    const ev: GatewayEvent = {
      event: "turn.exhausted",
      payload: { sessionId: "s1", turnNumber: 5, reason: "token_limit" },
    };
    expect(ev.event).toBe("turn.exhausted");
  });

  it("accepts 'checkpoint.waiting' event", () => {
    const ev: GatewayEvent = {
      event: "checkpoint.waiting",
      payload: {
        workerIdentity: "pi-w",
        assignmentId: 1,
        checkpointId: 42,
      },
    };
    expect(ev.event).toBe("checkpoint.waiting");
  });

  it("accepts 'context.pressure' event", () => {
    const ev: GatewayEvent = {
      event: "context.pressure",
      payload: { sessionId: "s1", usedTokens: 900, maxTokens: 1000 },
    };
    expect(ev.event).toBe("context.pressure");
  });

  it("accepts 'worker.stuck' event", () => {
    const ev: GatewayEvent = {
      event: "worker.stuck",
      payload: {
        workerIdentity: "pi-w",
        assignmentId: 1,
        reason: "no_tools",
        lastActivityAt: "2026-06-08T12:00:00.000Z",
        lastLifecycleState: "executing",
        idleTimeoutMs: 60000,
        remediationRequired: true,
      },
    };
    expect(ev.event).toBe("worker.stuck");
  });

  it("accepts 'gateway.shutdown' event", () => {
    const ev: GatewayEvent = {
      event: "gateway.shutdown",
      payload: { reason: "SIGTERM" },
    };
    expect(ev.event).toBe("gateway.shutdown");
    expect(ev.payload.reason).toBe("SIGTERM");
  });
});

describe("EventPayload helper", () => {
  it("extracts the correct payload type", () => {
    // Compile-time check: EventPayload<"session.created"> resolves
    // to { sessionId: string; kind: "conversational" | "worker" }
    type P = EventPayload<"session.created">;
    const payload: P = { sessionId: "x", kind: "worker" };
    expect(payload.sessionId).toBe("x");
    expect(payload.kind).toBe("worker");
  });
});
