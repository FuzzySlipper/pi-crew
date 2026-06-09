/**
 * Tests for context_status tool.
 *
 * @module pi-tools/__tests__/context-status.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { createWorkerPolicy } from "../execution-policy.js";
import { DrainModeManager } from "../drain-mode.js";
import {
  contextStatusTool,
  ContextUsageTrackerImpl,
  TokenPressureEmitter,
} from "../context-status.js";

describe("ContextUsageTrackerImpl", () => {
  it("starts with zero usage", () => {
    const tracker = new ContextUsageTrackerImpl();
    expect(tracker.usagePercent).toBe(0);
    expect(tracker.tokensUsed).toBe(0);
    expect(tracker.tokensTotal).toBe(200_000);
    expect(tracker.tokensRemaining).toBe(200_000);
  });

  it("accepts initial values", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 50_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 5,
    });
    expect(tracker.tokensUsed).toBe(50_000);
    expect(tracker.tokensTotal).toBe(100_000);
    expect(tracker.usagePercent).toBe(50);
  });

  it("updates from external snapshot", () => {
    const tracker = new ContextUsageTrackerImpl();
    tracker.update({
      tokensUsed: 80_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 3,
    });
    expect(tracker.tokensUsed).toBe(80_000);
    expect(tracker.usagePercent).toBe(80);
    expect(tracker.tokensRemaining).toBe(20_000);
  });

  it("accumulates incremental usage", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 10_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 10,
    });

    tracker.accumulate({ tokensUsed: 5_000 });
    expect(tracker.tokensUsed).toBe(15_000);
    expect(tracker.usagePercent).toBe(15);

    tracker.accumulate({ tokensUsed: 3_000 });
    expect(tracker.tokensUsed).toBe(18_000);
  });

  it("accumulate + update interoperate correctly", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 0,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 20,
    });

    tracker.accumulate({ tokensUsed: 50_000 });
    tracker.accumulate({ tokensUsed: 30_000 });
    expect(tracker.tokensUsed).toBe(80_000);

    // update replaces, not accumulates
    tracker.update({
      tokensUsed: 100_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 10,
    });
    expect(tracker.tokensUsed).toBe(100_000);
  });
});

describe("TokenPressureEmitter", () => {
  let eventBus: FakeEventBus;
  let logger: FakeLogger;
  let emitter: TokenPressureEmitter;

  beforeEach(() => {
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
    emitter = new TokenPressureEmitter();
  });

  it("emits nothing below 70%", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 50_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 10,
    });

    emitter.checkAndEmit(tracker, "sess-1", eventBus, logger);

    const pressureEvents = eventBus.emitted.filter((e) => e.event === "context.pressure");
    expect(pressureEvents).toHaveLength(0);
  });

  it("emits at 70% threshold", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 70_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 5,
    });

    emitter.checkAndEmit(tracker, "sess-1", eventBus, logger);

    const pressureEvents = eventBus.emitted.filter((e) => e.event === "context.pressure");
    expect(pressureEvents).toHaveLength(1);
    expect(pressureEvents[0]?.payload).toMatchObject({
      sessionId: "sess-1",
      usedTokens: 70_000,
      maxTokens: 100_000,
    });
  });

  it("emits at 85% and 95% thresholds", () => {
    // First prime the 70% threshold
    const t0 = new ContextUsageTrackerImpl({
      tokensUsed: 72_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 5,
    });
    emitter.checkAndEmit(t0, "sess-1", eventBus, logger);
    expect(eventBus.emitted.filter((e) => e.event === "context.pressure")).toHaveLength(1); // 70%

    // 85% — second event
    const t1 = new ContextUsageTrackerImpl({
      tokensUsed: 86_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 3,
    });
    emitter.checkAndEmit(t1, "sess-1", eventBus, logger);
    expect(eventBus.emitted.filter((e) => e.event === "context.pressure")).toHaveLength(2); // 70% + 85%

    // 95% — third event
    const t2 = new ContextUsageTrackerImpl({
      tokensUsed: 96_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 1,
    });
    emitter.checkAndEmit(t2, "sess-1", eventBus, logger);
    expect(eventBus.emitted.filter((e) => e.event === "context.pressure")).toHaveLength(3); // 70% + 85% + 95%
  });

  it("does not re-emit the same threshold", () => {
    // Cross 70% three times
    for (let i = 0; i < 3; i++) {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 75_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 5,
      });
      emitter.checkAndEmit(tracker, "sess-1", eventBus, logger);
    }

    const pressureEvents = eventBus.emitted.filter((e) => e.event === "context.pressure");
    expect(pressureEvents).toHaveLength(1); // only 70% emitted once
  });

  it("reset clears emitted thresholds", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 75_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 5,
    });

    emitter.checkAndEmit(tracker, "sess-1", eventBus, logger);
    expect(eventBus.emitted.filter((e) => e.event === "context.pressure")).toHaveLength(1);

    emitter.reset();

    // Same threshold should emit again after reset
    emitter.checkAndEmit(tracker, "sess-1", eventBus, logger);
    expect(eventBus.emitted.filter((e) => e.event === "context.pressure")).toHaveLength(2);
  });

  it("emits 70% and 85% in separate calls, 95% not crossed", () => {
    // 70%
    const t1 = new ContextUsageTrackerImpl({
      tokensUsed: 71_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 5,
    });
    emitter.checkAndEmit(t1, "sess-1", eventBus, logger);

    // 85%
    const t2 = new ContextUsageTrackerImpl({
      tokensUsed: 86_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 3,
    });
    emitter.checkAndEmit(t2, "sess-1", eventBus, logger);

    const events = eventBus.emitted.filter((e) => e.event === "context.pressure");
    expect(events).toHaveLength(2);

    // 95% not yet crossed — second call at same level no-op
    emitter.checkAndEmit(t2, "sess-1", eventBus, logger);
    expect(eventBus.emitted.filter((e) => e.event === "context.pressure")).toHaveLength(2);
  });
});

describe("contextStatusTool", () => {
  let eventBus: FakeEventBus;
  let logger: FakeLogger;

  beforeEach(() => {
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
  });

  it("returns normal recommendation for low usage", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 20_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 10,
    });

    const snapshot = contextStatusTool(tracker, null);

    expect(snapshot.usagePercent).toBe(10);
    expect(snapshot.compressionImminent).toBe(false);
    expect(snapshot.recommendation).toContain("Normal");
    expect(snapshot.drainActive).toBe(false);
  });

  it("reports compression imminent above 70%", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 150_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 3,
    });

    const snapshot = contextStatusTool(tracker, null);

    expect(snapshot.usagePercent).toBe(75);
    expect(snapshot.compressionImminent).toBe(true);
    expect(snapshot.recommendation).toContain("WARNING");
  });

  it("reports critical above 85%", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 180_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 1,
    });

    const snapshot = contextStatusTool(tracker, null);

    expect(snapshot.usagePercent).toBe(90);
    expect(snapshot.recommendation).toContain("CRITICAL");
  });

  it("reports emergency above 95%", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 195_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 0,
    });

    const snapshot = contextStatusTool(tracker, null);

    expect(snapshot.recommendation).toContain("EMERGENCY");
  });

  it("reports drain mode status", () => {
    const policy = createWorkerPolicy({
      assignmentId: "1",
      runId: "r1",
      taskId: "1",
      role: "coder",
    });
    const drainManager = new DrainModeManager(eventBus, logger, "sess-1", policy);
    drainManager.activate("iteration_budget");

    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 50_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 5,
    });

    const snapshot = contextStatusTool(tracker, drainManager);

    expect(snapshot.drainActive).toBe(true);
  });

  it("emits context.pressure event on threshold crossing", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 150_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 3,
    });

    contextStatusTool(tracker, null, undefined, eventBus, logger, "sess-1");

    const pressureEvents = eventBus.emitted.filter((e) => e.event === "context.pressure");
    expect(pressureEvents.length).toBe(1);
    expect(pressureEvents[0]?.payload).toMatchObject({
      sessionId: "sess-1",
    });
  });

  it("deduplicates inline context.pressure events per threshold", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 150_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 3,
    });

    contextStatusTool(tracker, null, undefined, eventBus, logger, "sess-1");
    contextStatusTool(tracker, null, undefined, eventBus, logger, "sess-1");

    expect(eventBus.emitted.filter((e) => e.event === "context.pressure")).toHaveLength(1);

    tracker.update({
      tokensUsed: 172_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 2,
    });
    contextStatusTool(tracker, null, undefined, eventBus, logger, "sess-1");

    expect(eventBus.emitted.filter((e) => e.event === "context.pressure")).toHaveLength(2);
  });

  it("does not emit context.pressure for normal usage", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 10_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 10,
    });

    contextStatusTool(tracker, null, undefined, eventBus, logger, "sess-1");

    const pressureEvents = eventBus.emitted.filter((e) => e.event === "context.pressure");
    expect(pressureEvents.length).toBe(0);
  });

  it("respects custom thresholds", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 80_000,
      tokensTotal: 100_000,
      turnsRemainingEstimate: 5,
    });

    const snapshot = contextStatusTool(tracker, null, {
      compressionThreshold: 50,
      criticalThreshold: 90,
    });

    // 80% > 50% compression, < 90% critical
    expect(snapshot.compressionImminent).toBe(true);
    expect(snapshot.recommendation).toContain("WARNING");
  });

  it("returns drainActive as false when no drain manager", () => {
    const tracker = new ContextUsageTrackerImpl();
    const snapshot = contextStatusTool(tracker, null);
    expect(snapshot.drainActive).toBe(false);
  });

  it("returns real token counts from accumulated usage", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 0,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 20,
    });

    // Simulate pi-agent-core token accumulation
    tracker.accumulate({ tokensUsed: 5_000 });
    tracker.accumulate({ tokensUsed: 3_500 });
    tracker.accumulate({ tokensUsed: 12_000 });

    const snapshot = contextStatusTool(tracker, null);

    expect(snapshot.tokensUsed).toBe(20_500);
    expect(snapshot.tokensTotal).toBe(200_000);
    expect(snapshot.tokensRemaining).toBe(179_500);
    expect(snapshot.usagePercent).toBe(10.25);
  });
});
