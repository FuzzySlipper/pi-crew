/**
 * Tests for context_status tool.
 *
 * @module pi-tools/__tests__/context-status.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { createWorkerPolicy } from "../worker-policy.js";
import { DrainModeManager } from "../drain-mode.js";
import {
  contextStatusTool,
  ContextUsageTrackerImpl,
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

  it("reports drain mode status", () => {
    const policy = createWorkerPolicy({
      assignmentId: "1",
      runId: "r1",
      taskId: "1",
      role: "coder",
    });
    const drainManager = new DrainModeManager(
      eventBus,
      logger,
      "sess-1",
      policy,
    );
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

    const pressureEvents = eventBus.emitted.filter(
      (e) => e.event === "context.pressure",
    );
    expect(pressureEvents.length).toBe(1);
    expect(pressureEvents[0]?.payload).toMatchObject({
      sessionId: "sess-1",
    });
  });

  it("does not emit context.pressure for normal usage", () => {
    const tracker = new ContextUsageTrackerImpl({
      tokensUsed: 10_000,
      tokensTotal: 200_000,
      turnsRemainingEstimate: 10,
    });

    contextStatusTool(tracker, null, undefined, eventBus, logger, "sess-1");

    const pressureEvents = eventBus.emitted.filter(
      (e) => e.event === "context.pressure",
    );
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
});
