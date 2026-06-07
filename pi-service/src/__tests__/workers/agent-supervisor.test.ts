/**
 * Tests for AgentSupervisor — Agent event → GatewayEvent bridge.
 *
 * Proves that pi-agent-core Agent events are mapped to typed GatewayEvents
 * with Den correlation IDs (assignment/run/task/session/profile).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { GatewayEvent } from "@pi-crew/core";
import {
  AgentSupervisor,
  type AgentSupervisorConfig,
  type AgentLike,
} from "../../workers/agent-supervisor.js";
import type { WorkerBinding } from "../../sessions/types.js";

// ── FakeAgent: test fake for pi-agent-core Agent event streams ──

type EventListener = (
  event: AgentEvent,
  signal: AbortSignal,
) => Promise<void> | void;

export class FakeAgent implements AgentLike {
  #listeners: EventListener[] = [];
  #aborted = false;
  readonly signal: AbortSignal;

  constructor() {
    const controller = new AbortController();
    this.signal = controller.signal;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.push(listener);
    return () => {
      const idx = this.#listeners.indexOf(listener);
      if (idx !== -1) {
        this.#listeners.splice(idx, 1);
      }
    };
  }

  /** Feed a sequence of events through all subscribed listeners. */
  async feed(...events: AgentEvent[]): Promise<void> {
    for (const event of events) {
      for (const listener of this.#listeners) {
        await listener(event, this.signal);
      }
    }
  }

  abort(): void {
    this.#aborted = true;
  }

  get aborted(): boolean {
    return this.#aborted;
  }
}

// ── Test helpers ─────────────────────────────────────────────────

function makeBinding(overrides?: Partial<WorkerBinding>): WorkerBinding {
  return {
    assignmentId: "695",
    runId: "piw_20260607065159_9aba407c",
    taskId: "2068",
    projectId: "pi-crew",
    role: "coder",
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<AgentSupervisorConfig>,
): AgentSupervisorConfig {
  const binding = overrides?.binding ?? makeBinding();
  return {
    binding,
    sessionId: "session-1",
    profileId: "spawned-coder",
    eventBus: new FakeEventBus(),
    logger: new FakeLogger(),
    ...overrides,
  };
}

function agentStartEvent(): AgentEvent {
  return { type: "agent_start" };
}

function turnStartEvent(): AgentEvent {
  return { type: "turn_start" };
}

function toolStartEvent(
  toolCallId: string,
  toolName: string,
  args?: unknown,
): AgentEvent {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args: args ?? {},
  };
}

function toolEndEvent(
  toolCallId: string,
  toolName: string,
  result?: unknown,
  isError?: boolean,
): AgentEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result: result ?? "done",
    isError: isError ?? false,
  };
}

function turnEndEvent(): AgentEvent {
  // AgentEvent["turn_end"] has { message: AgentMessage; toolResults: ToolResultMessage[] }
  // We construct a minimal object and cast through unknown to satisfy the union.
  const turnEnd = {
    type: "turn_end" as const,
    message: {
      role: "assistant" as const,
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
      timestamp: Date.now(),
    },
    toolResults: [],
  };
  return turnEnd as unknown as AgentEvent;
}

function agentEndEvent(): AgentEvent {
  return {
    type: "agent_end",
    messages: [],
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("AgentSupervisor", () => {
  let fakeAgent: FakeAgent;
  let eventBus: FakeEventBus;
  let logger: FakeLogger;
  let supervisor: AgentSupervisor;

  beforeEach(() => {
    fakeAgent = new FakeAgent();
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
    const config = makeConfig({ eventBus, logger });
    supervisor = new AgentSupervisor(config, fakeAgent);
    supervisor.start();
  });

  afterEach(() => {
    supervisor.stop();
  });

  // ── turn_start → turn.started ──────────────────────────────

  it("emits turn.started on turn_start", async () => {
    await fakeAgent.feed(turnStartEvent());

    const started = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "turn.started",
    );
    expect(started.length).toBe(1);
    const payload = started[0]?.payload;
    expect(payload?.sessionId).toBe("session-1");
    expect(payload?.assignmentId).toBe("695");
    expect(payload?.runId).toBe("piw_20260607065159_9aba407c");
    expect(payload?.taskId).toBe("2068");
    expect(payload?.profileId).toBe("spawned-coder");
    expect(payload?.turnNumber).toBe(1);
  });

  it("increments turn counter on each turn_start", async () => {
    await fakeAgent.feed(
      turnStartEvent(),
      turnEndEvent(),
      turnStartEvent(),
      turnEndEvent(),
    );

    expect(supervisor.turnCount).toBe(2);
    const started = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "turn.started",
    );
    expect(started.length).toBe(2);
  });

  // ── tool_execution_start → tool.called ───────────────────────

  it("emits tool.called on tool_execution_start", async () => {
    await fakeAgent.feed(toolStartEvent("tc-1", "read_file", { path: "/x" }));

    const called = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "tool.called",
    );
    expect(called.length).toBe(1);
    const payload = called[0]?.payload;
    expect(payload?.toolName).toBe("read_file");
    expect(payload?.sessionId).toBe("session-1");
    expect(payload?.assignmentId).toBe("695");
    expect(payload?.runId).toBe("piw_20260607065159_9aba407c");
    expect(payload?.taskId).toBe("2068");
    expect(payload?.profileId).toBe("spawned-coder");
  });

  it("preserves correlation IDs in audit log on tool.called", async () => {
    // The supervisor emits tool.called with sessionId; the full
    // correlation context is captured in the logger context.
    await fakeAgent.feed(toolStartEvent("tc-2", "calculate"));

    const infoLogs = logger.entries.filter(
      (e) => e.level === "info" && e.message === "AgentSupervisor: tool.start",
    );
    expect(infoLogs.length).toBe(1);
    const ctx = infoLogs[0]?.context;
    expect(ctx?.assignmentId).toBe("695");
    expect(ctx?.runId).toBe("piw_20260607065159_9aba407c");
    expect(ctx?.taskId).toBe("2068");
    expect(ctx?.profileId).toBe("spawned-coder");
    expect(ctx?.toolName).toBe("calculate");
  });

  // ── tool_execution_end → tool.completed ──────────────────────

  it("emits tool.completed on tool_execution_end (success)", async () => {
    await fakeAgent.feed(
      toolStartEvent("tc-3", "bash"),
      toolEndEvent("tc-3", "bash", "output", false),
    );

    const completed = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "tool.completed",
    );
    expect(completed.length).toBe(1);
    const payload = completed[0]?.payload;
    expect(payload?.toolName).toBe("bash");
    expect(payload?.sessionId).toBe("session-1");
    expect(payload?.assignmentId).toBe("695");
    expect(payload?.runId).toBe("piw_20260607065159_9aba407c");
    expect(payload?.taskId).toBe("2068");
    expect(payload?.profileId).toBe("spawned-coder");
    expect(payload?.success).toBe(true);
  });

  it("emits tool.completed with success=false on error", async () => {
    await fakeAgent.feed(
      toolStartEvent("tc-4", "dangerous"),
      toolEndEvent("tc-4", "dangerous", "permission denied", true),
    );

    const completed = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "tool.completed",
    );
    expect(completed.length).toBe(1);
    const payload = completed[0]?.payload;
    expect(payload?.toolName).toBe("dangerous");
    expect(payload?.success).toBe(false);
  });

  // ── turn_end → turn.completed ────────────────────────────────

  it("emits turn.completed on turn_end", async () => {
    await fakeAgent.feed(turnStartEvent(), turnEndEvent());

    const completed = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "turn.completed",
    );
    expect(completed.length).toBe(1);
    const payload = completed[0]?.payload;
    expect(payload?.sessionId).toBe("session-1");
    expect(payload?.assignmentId).toBe("695");
    expect(payload?.runId).toBe("piw_20260607065159_9aba407c");
    expect(payload?.taskId).toBe("2068");
    expect(payload?.profileId).toBe("spawned-coder");
    expect(payload?.turnNumber).toBeGreaterThanOrEqual(1);
    expect(typeof payload?.durationMs).toBe("number");
  });

  // ── Full sequence: turn_start → tool → turn_end → agent_end

  it("emits correct GatewayEvent sequence for a full agent lifecycle", async () => {
    await fakeAgent.feed(
      turnStartEvent(),
      toolStartEvent("tc-a", "read_file"),
      toolEndEvent("tc-a", "read_file", "content", false),
      toolStartEvent("tc-b", "write_file"),
      toolEndEvent("tc-b", "write_file", "ok", false),
      turnEndEvent(),
      agentEndEvent(),
    );

    const events = eventBus.emitted.map((e: GatewayEvent) => e.event);

    // Expected: turn.started, tool.called, tool.completed,
    //           tool.called, tool.completed, turn.completed
    expect(events).toEqual([
      "turn.started",
      "tool.called",
      "tool.completed",
      "tool.called",
      "tool.completed",
      "turn.completed",
    ]);
  });

  it("emits turn.completed with correct turn number", async () => {
    await fakeAgent.feed(
      turnStartEvent(),
      toolStartEvent("tc-x", "grep"),
      toolEndEvent("tc-x", "grep", "found", false),
      turnEndEvent(),
      turnStartEvent(),
      toolStartEvent("tc-y", "sed"),
      toolEndEvent("tc-y", "sed", "replaced", false),
      turnEndEvent(),
    );

    // Turn 1 and Turn 2
    const completions = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "turn.completed",
    );
    expect(completions.length).toBe(2);

    const t1 = completions[0]?.payload;
    const t2 = completions[1]?.payload;
    expect(t1?.turnNumber).toBe(1);
    expect(t2?.turnNumber).toBe(2);
    expect(t2?.sessionId).toBe("session-1");
  });

  // ── agent_end cleanup ────────────────────────────────────────

  it("logs agent end with message count", async () => {
    await fakeAgent.feed(
      turnStartEvent(),
      turnEndEvent(),
      agentEndEvent(),
    );

    const debugLogs = logger.entries.filter(
      (e) =>
        e.level === "info" && e.message === "AgentSupervisor: agent.end",
    );
    expect(debugLogs.length).toBe(1);
    const ctx = debugLogs[0]?.context;
    expect(ctx?.assignmentId).toBe("695");
    expect(ctx?.turnCount).toBe(1);
  });

  // ── Stop / unsubscribe ───────────────────────────────────────

  it("stops emitting events after stop()", async () => {
    supervisor.stop();
    const before = eventBus.emitted.length;

    await fakeAgent.feed(
      agentStartEvent(),
      toolStartEvent("tc-z", "test"),
    );

    // No new events after stop
    expect(eventBus.emitted.length).toBe(before);
  });

  it("unsubscribe is idempotent", () => {
    supervisor.stop();
    supervisor.stop(); // second call should not throw
  });

  // ── Correlation context propagation ──────────────────────────

  it("carries full Den correlation context in all lifecycle logs", async () => {
    await fakeAgent.feed(
      agentStartEvent(),
      turnStartEvent(),
      toolStartEvent("tc-abc", "calculator"),
      toolEndEvent("tc-abc", "calculator", "42", false),
      turnEndEvent(),
      agentEndEvent(),
    );

    // Every lifecycle log should include assignment/run/task/session/profile
    const lifecycleLogs = logger.entries.filter(
      (e) =>
        typeof e.message === "string" &&
        e.message.startsWith("AgentSupervisor:"),
    );

    // agent.start, turn.start is not logged at info level, so: agent.start, tool.start, turn.end, agent.end = 4
    expect(lifecycleLogs.length).toBeGreaterThanOrEqual(4);

    for (const log of lifecycleLogs) {
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.assignmentId).toBe("695");
      expect(ctx.runId).toBe("piw_20260607065159_9aba407c");
      expect(ctx.taskId).toBe("2068");
      expect(ctx.profileId).toBe("spawned-coder");
      expect(ctx.sessionId).toBe("session-1");
    }
  });
});

describe("FakeAgent", () => {
  it("delivers events to subscribers in order", async () => {
    const agent = new FakeAgent();
    const received: string[] = [];

    agent.subscribe((event) => {
      received.push(event.type);
    });

    await agent.feed(
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "agent_end", messages: [] },
    );

    expect(received).toEqual(["agent_start", "turn_start", "agent_end"]);
  });

  it("supports multiple subscribers", async () => {
    const agent = new FakeAgent();
    const a: string[] = [];
    const b: string[] = [];

    agent.subscribe((event) => {
      a.push(event.type);
    });
    agent.subscribe((event) => {
      b.push(event.type);
    });

    await agent.feed({ type: "agent_start" });

    expect(a).toEqual(["agent_start"]);
    expect(b).toEqual(["agent_start"]);
  });

  it("unsubscribe removes listener", async () => {
    const agent = new FakeAgent();
    const received: string[] = [];

    const unsub = agent.subscribe((event) => {
      received.push(event.type);
    });
    unsub();

    await agent.feed({ type: "agent_start" });
    expect(received).toEqual([]);
  });
});
