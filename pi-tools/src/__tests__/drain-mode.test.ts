/**
 * Tests for DrainModeManager.
 *
 * @module pi-tools/__tests__/drain-mode.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { createWorkerPolicy } from "../execution-policy.js";
import { DrainModeManager } from "../drain-mode.js";
import { ContextUsageTrackerImpl } from "../context-status.js";

describe("DrainModeManager", () => {
  let eventBus: FakeEventBus;
  let logger: FakeLogger;
  let manager: DrainModeManager;
  const policy = createWorkerPolicy({
    assignmentId: "1",
    runId: "r1",
    taskId: "1",
    role: "coder",
    maxIterations: 50,
  });

  beforeEach(() => {
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
    manager = new DrainModeManager(eventBus, logger, "sess-1", policy);
  });

  describe("initial state", () => {
    it("is not active initially", () => {
      expect(manager.isActive).toBe(false);
      expect(manager.currentState).toBeNull();
    });
  });

  describe("isEssential", () => {
    it("identifies global essential tools", () => {
      expect(manager.isEssential("context_status")).toBe(true);
      expect(manager.isEssential("post_structured_completion")).toBe(true);
    });

    it("does not consider regular tools essential", () => {
      expect(manager.isEssential("read_file")).toBe(false);
      expect(manager.isEssential("terminal")).toBe(false);
    });
  });

  describe("addEssentialTool / removeEssentialTool", () => {
    it("adds an extra essential tool", () => {
      manager.addEssentialTool("send_notification");
      expect(manager.isEssential("send_notification")).toBe(true);
    });

    it("removes an extra essential tool", () => {
      manager.addEssentialTool("send_notification");
      const removed = manager.removeEssentialTool("send_notification");
      expect(removed).toBe(true);
      expect(manager.isEssential("send_notification")).toBe(false);
    });

    it("does not affect global essential tools on removal", () => {
      const removed = manager.removeEssentialTool("context_status");
      expect(removed).toBe(false);
      expect(manager.isEssential("context_status")).toBe(true);
    });
  });

  describe("activate / deactivate", () => {
    it("activates drain mode", () => {
      manager.activate("iteration_budget");
      expect(manager.isActive).toBe(true);
      expect(manager.currentState?.reason).toBe("iteration_budget");
    });

    it("emits drain.activated event", () => {
      manager.activate("context_limit");

      const events = eventBus.emitted.filter(
        (e) => e.event === "drain.activated",
      );
      expect(events.length).toBe(1);
      expect(events[0]?.payload).toMatchObject({
        sessionId: "sess-1",
        reason: "context_limit",
        assignmentId: "1",
      });
    });

    it("is idempotent on double activate", () => {
      manager.activate("iteration_budget");
      manager.activate("timeout");
      expect(manager.currentState?.reason).toBe("iteration_budget");
    });

    it("deactivates drain mode", () => {
      manager.activate("iteration_budget");
      manager.deactivate();
      expect(manager.isActive).toBe(false);
    });

    it("emits drain.deactivated event", () => {
      manager.activate("iteration_budget");
      manager.deactivate();

      const events = eventBus.emitted.filter(
        (e) => e.event === "drain.deactivated",
      );
      expect(events.length).toBe(1);
    });

    it("deactivate is idempotent when not active", () => {
      manager.deactivate();
      expect(manager.isActive).toBe(false);
      // No event emitted
      const events = eventBus.emitted.filter(
        (e) => e.event === "drain.deactivated",
      );
      expect(events.length).toBe(0);
    });
  });

  describe("filterForDrain", () => {
    const allTools = [
      "context_status",
      "post_structured_completion",
      "read_file",
      "write_file",
      "terminal",
      "web_search",
    ];

    it("returns all tools when drain is inactive", () => {
      const result = manager.filterForDrain(allTools);
      expect(result).toEqual(allTools);
    });

    it("only keeps essential tools when drain is active", () => {
      manager.activate("iteration_budget");
      const result = manager.filterForDrain(allTools);

      expect(result).toContain("context_status");
      expect(result).toContain("post_structured_completion");
      expect(result).not.toContain("read_file");
      expect(result).not.toContain("write_file");
      expect(result).not.toContain("terminal");
      expect(result).not.toContain("web_search");
    });

    it("preserves extra essential tools during drain", () => {
      manager.addEssentialTool("notify_user");
      manager.activate("iteration_budget");

      const tools = [
        "context_status",
        "post_structured_completion",
        "notify_user",
        "terminal",
      ];
      const result = manager.filterForDrain(tools);

      expect(result).toEqual([
        "context_status",
        "post_structured_completion",
        "notify_user",
      ]);
    });
  });

  describe("autoActivateForIterations", () => {
    it("does not activate when budget is healthy", () => {
      const activated = manager.autoActivateForIterations(20);
      expect(activated).toBe(false);
      expect(manager.isActive).toBe(false);
    });

    it("activates when budget is at 80% threshold", () => {
      const activated = manager.autoActivateForIterations(40);
      expect(activated).toBe(true);
      expect(manager.isActive).toBe(true);
      expect(manager.currentState?.reason).toBe("iteration_budget");
    });

    it("returns true when already active (idempotent)", () => {
      manager.activate("iteration_budget");
      const activated = manager.autoActivateForIterations(45);
      expect(activated).toBe(true);
    });
  });

  describe("shouldDrainForIterations", () => {
    it("returns false below 80% threshold", () => {
      expect(manager.shouldDrainForIterations(39)).toBe(false);
    });

    it("returns true at or above 80% threshold", () => {
      expect(manager.shouldDrainForIterations(40)).toBe(true);
      expect(manager.shouldDrainForIterations(45)).toBe(true);
    });
  });

  describe("autoActivateForTokens", () => {
    it("does not activate when token usage is below 80%", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 50_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 10,
      });

      const activated = manager.autoActivateForTokens(tracker);
      expect(activated).toBe(false);
      expect(manager.isActive).toBe(false);
    });

    it("activates when token usage reaches 80%", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 80_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 5,
      });

      const activated = manager.autoActivateForTokens(tracker);
      expect(activated).toBe(true);
      expect(manager.isActive).toBe(true);
      expect(manager.currentState?.reason).toBe("context_limit");
    });

    it("activates when token usage exceeds 80%", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 95_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 1,
      });

      const activated = manager.autoActivateForTokens(tracker);
      expect(activated).toBe(true);
      expect(manager.isActive).toBe(true);
    });

    it("returns true when drain already active (idempotent)", () => {
      manager.activate("context_limit");

      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 90_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 1,
      });

      const activated = manager.autoActivateForTokens(tracker);
      expect(activated).toBe(true);
    });

    it("emits drain.activated with context_limit reason", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 85_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 3,
      });

      manager.autoActivateForTokens(tracker);

      const events = eventBus.emitted.filter(
        (e) => e.event === "drain.activated",
      );
      expect(events.length).toBe(1);
      expect(events[0]?.payload).toMatchObject({
        reason: "context_limit",
        sessionId: "sess-1",
        assignmentId: "1",
      });
    });

    it("works with incremental token accumulation", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 40_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 10,
      });

      // 40% — no drain
      expect(manager.autoActivateForTokens(tracker)).toBe(false);

      // Accumulate to 80% — drain activates
      tracker.accumulate({ tokensUsed: 40_000 });
      expect(manager.autoActivateForTokens(tracker)).toBe(true);
      expect(manager.isActive).toBe(true);
    });

    it("default 200k total requires 160k tokens for activation", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 0,
        tokensTotal: 200_000,
        turnsRemainingEstimate: 20,
      });

      // Below threshold
      tracker.accumulate({ tokensUsed: 150_000 });
      expect(manager.autoActivateForTokens(tracker)).toBe(false);

      // At threshold
      tracker.accumulate({ tokensUsed: 10_000 });
      expect(manager.autoActivateForTokens(tracker)).toBe(true);
    });
  });

  describe("shouldDrainForTokens", () => {
    it("returns false below 80%", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 79_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 10,
      });
      expect(manager.shouldDrainForTokens(tracker)).toBe(false);
    });

    it("returns true at 80% or above", () => {
      const t80 = new ContextUsageTrackerImpl({
        tokensUsed: 80_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 5,
      });
      expect(manager.shouldDrainForTokens(t80)).toBe(true);

      const t90 = new ContextUsageTrackerImpl({
        tokensUsed: 90_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 1,
      });
      expect(manager.shouldDrainForTokens(t90)).toBe(true);
    });
  });

  describe("drain tool filtering with real token state", () => {
    it("filters tools when token drain is active", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 85_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 3,
      });

      manager.autoActivateForTokens(tracker);
      expect(manager.isActive).toBe(true);

      const tools = ["context_status", "terminal", "web_search"];
      const filtered = manager.filterForDrain(tools);
      expect(filtered).toEqual(["context_status"]);
    });

    it("passes all tools when token drain is not active", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 30_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 10,
      });

      // Not activated — below 80%
      manager.autoActivateForTokens(tracker);
      expect(manager.isActive).toBe(false);

      const tools = ["context_status", "terminal", "web_search"];
      const filtered = manager.filterForDrain(tools);
      expect(filtered).toEqual(tools);
    });

    it("preserves post_structured_completion during token drain", () => {
      const tracker = new ContextUsageTrackerImpl({
        tokensUsed: 90_000,
        tokensTotal: 100_000,
        turnsRemainingEstimate: 1,
      });

      manager.autoActivateForTokens(tracker);

      const tools = ["write_file", "post_structured_completion", "terminal"];
      const filtered = manager.filterForDrain(tools);
      expect(filtered).toEqual(["post_structured_completion"]);
    });
  });
});
