/** Token-tracking tests for AgentSupervisor. */

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

type EventListener = (
  event: AgentEvent,
  signal: AbortSignal,
) => Promise<void> | void;

class FakeAgent implements AgentLike {
  #listeners: EventListener[] = [];
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

  async feed(...events: AgentEvent[]): Promise<void> {
    for (const event of events) {
      for (const listener of this.#listeners) {
        await listener(event, this.signal);
      }
    }
  }
}

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

function turnStartEvent(): AgentEvent {
  return { type: "turn_start" };
}

function turnEndEvent(): AgentEvent {
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

describe("AgentSupervisor token tracking", () => {
  let fakeAgent: FakeAgent;
  let eventBus: FakeEventBus;
  let logger: FakeLogger;
  let supervisor: AgentSupervisor;

  beforeEach(() => {
    fakeAgent = new FakeAgent();
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
    supervisor = new AgentSupervisor(makeConfig({ eventBus, logger }), fakeAgent);
    supervisor.start();
  });

  afterEach(() => {
    supervisor.stop();
  });

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
