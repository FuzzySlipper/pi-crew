/**
 * Tests for AgentSupervisor — Agent event → GatewayEvent bridge.
 *
 * Proves that pi-agent-core Agent events are mapped to typed GatewayEvents
 * with Den correlation IDs (assignment/run/task/session/profile).
 *
 * Token-tracking tests verify real pi-agent-core token usage accumulation
 * from message_end events and context.pressure threshold emission.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { GatewayEvent } from "@pi-crew/core";
import { ContextUsageTrackerImpl } from "@pi-crew/tools";
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

function messageEndEvent(
  tokens: number,
  role?: string,
): AgentEvent {
  const msg = {
    role: (role ?? "assistant") as "assistant",
    content: [{ type: "text" as const, text: "ok" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "end_turn" as const,
    timestamp: Date.now(),
  };

  return {
    type: "message_end",
    message: msg,
  } as unknown as AgentEvent;
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

  // ── Token tracking ───────────────────────────────────────────

  describe("token tracking", () => {
    it("accumulates tokens from message_end events", async () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 200_000,
        turnsRemainingEstimate: 20,
      });
      const config = makeConfig({ eventBus, logger, tokenTracker: tracker });
      const tokSupervisor = new AgentSupervisor(config, fakeAgent);
      tokSupervisor.start();

      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(5_000),
        messageEndEvent(3_500),
        turnEndEvent(),
      );

      expect(tokSupervisor.tokensUsed).toBe(8_500);
      expect(tracker.tokensUsed).toBe(8_500);

      tokSupervisor.stop();
    });

    it("accumulates across multiple turns", async () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 200_000,
        turnsRemainingEstimate: 20,
      });
      const config = makeConfig({ eventBus, logger, tokenTracker: tracker });
      const tokSupervisor = new AgentSupervisor(config, fakeAgent);
      tokSupervisor.start();

      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(10_000),
        turnEndEvent(),
        turnStartEvent(),
        messageEndEvent(12_000),
        turnEndEvent(),
      );

      expect(tokSupervisor.tokensUsed).toBe(22_000);

      tokSupervisor.stop();
    });

    it("tokensUsed returns 0 when no tracker configured", () => {
      // Default supervisor (from beforeEach) has no tracker
      expect(supervisor.tokensUsed).toBe(0);
    });

    it("tokenTracker getter returns undefined when not configured", () => {
      expect(supervisor.tokenTracker).toBeUndefined();
    });

    it("tokenTracker getter returns the tracker when configured", () => {
      const tracker = new ContextUsageTrackerImpl();
      const config = makeConfig({ eventBus, logger, tokenTracker: tracker });
      const tokSupervisor = new AgentSupervisor(config, fakeAgent);

      expect(tokSupervisor.tokenTracker).toBe(tracker);
    });

    it("emits context.pressure at 70% threshold after turn_end", async () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 20,
      });
      const config = makeConfig({ eventBus, logger, tokenTracker: tracker });
      const tokSupervisor = new AgentSupervisor(config, fakeAgent);
      tokSupervisor.start();

      // Accumulate 70k tokens via message_end events
      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(70_000),
        turnEndEvent(),
      );

      const pressureEvents = eventBus.emitted.filter(
        (e: GatewayEvent) => e.event === "context.pressure",
      );
      expect(pressureEvents.length).toBe(1);
      expect(pressureEvents[0]?.payload).toMatchObject({
        sessionId: "session-1",
        usedTokens: 70_000,
        maxTokens: 100_000,
      });

      tokSupervisor.stop();
    });

    it("emits context.pressure only once per threshold", async () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 20,
      });
      const config = makeConfig({ eventBus, logger, tokenTracker: tracker });
      const tokSupervisor = new AgentSupervisor(config, fakeAgent);
      tokSupervisor.start();

      // First turn — cross 70%
      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(75_000),
        turnEndEvent(),
      );
      expect(
        eventBus.emitted.filter(
          (e: GatewayEvent) => e.event === "context.pressure",
        ),
      ).toHaveLength(1);

      // Second turn — still at 70%+ but not crossing new threshold
      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(5_000),
        turnEndEvent(),
      );
      expect(
        eventBus.emitted.filter(
          (e: GatewayEvent) => e.event === "context.pressure",
        ),
      ).toHaveLength(1);

      tokSupervisor.stop();
    });

    it("resets pressure thresholds on agent_start", async () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 20,
      });
      const config = makeConfig({ eventBus, logger, tokenTracker: tracker });
      const tokSupervisor = new AgentSupervisor(config, fakeAgent);
      tokSupervisor.start();

      // Cross 70%
      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(75_000),
        turnEndEvent(),
      );

      // Stop the first supervisor so it doesn't receive further events
      tokSupervisor.stop();

      // New supervisor with fresh tracker — simulates new agent session
      const tracker2 = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 20,
      });
      const config2 = makeConfig({
        eventBus,
        logger,
        tokenTracker: tracker2,
      });
      const tokSupervisor2 = new AgentSupervisor(config2, fakeAgent);
      tokSupervisor2.start();

      // Same usage crossed again, should re-emit 70%
      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(75_000),
        turnEndEvent(),
      );

      const pressureEvents = eventBus.emitted.filter(
        (e: GatewayEvent) => e.event === "context.pressure",
      );
      // First supervisor emitted 1 (70%), second supervisor emits 1 (70% re-crossed) = 2
      expect(pressureEvents.length).toBe(2);

      tokSupervisor2.stop();
    });

    it("does not emit context.pressure below threshold", async () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 200_000,
        turnsRemainingEstimate: 20,
      });
      const config = makeConfig({ eventBus, logger, tokenTracker: tracker });
      const tokSupervisor = new AgentSupervisor(config, fakeAgent);
      tokSupervisor.start();

      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(50_000), // 25%
        turnEndEvent(),
      );

      const pressureEvents = eventBus.emitted.filter(
        (e: GatewayEvent) => e.event === "context.pressure",
      );
      expect(pressureEvents.length).toBe(0);

      tokSupervisor.stop();
    });

    it("ignores non-assistant message_end events", async () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 20,
      });
      const config = makeConfig({ eventBus, logger, tokenTracker: tracker });
      const tokSupervisor = new AgentSupervisor(config, fakeAgent);
      tokSupervisor.start();

      // message_end with user role — should be ignored for token counting
      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(50_000, "user"),
        turnEndEvent(),
      );

      expect(tokSupervisor.tokensUsed).toBe(0);

      tokSupervisor.stop();
    });

    it("logs tokensUsed in turn.end context", async () => {
      const tokLogger = new FakeLogger();
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 200_000,
        turnsRemainingEstimate: 20,
      });
      const config = makeConfig({
        eventBus,
        logger: tokLogger,
        tokenTracker: tracker,
      });
      const tokSupervisor = new AgentSupervisor(config, fakeAgent);
      tokSupervisor.start();

      await fakeAgent.feed(
        turnStartEvent(),
        messageEndEvent(12_345),
        turnEndEvent(),
      );

      const turnEndLogs = tokLogger.entries.filter(
        (e) =>
          e.level === "info" && e.message === "AgentSupervisor: turn.end",
      );
      expect(turnEndLogs.length).toBe(1);
      const ctx = turnEndLogs[0]?.context;
      expect(ctx?.tokensUsed).toBe(12_345);

      tokSupervisor.stop();
    });
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
