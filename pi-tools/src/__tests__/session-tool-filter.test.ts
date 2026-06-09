/**
 * Tests for SessionToolFilter — composed policy + drain filtering.
 *
 * @module pi-tools/__tests__/session-tool-filter.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { createWorkerPolicy } from "../execution-policy.js";
import { DrainModeManager } from "../drain-mode.js";
import { SessionToolFilter } from "../session-tool-filter.js";

describe("SessionToolFilter", () => {
  let eventBus: FakeEventBus;
  let logger: FakeLogger;
  let filter: SessionToolFilter;

  const allTools = [
    "context_status",
    "post_structured_completion",
    "read_file",
    "write_file",
    "terminal",
    "web_search",
    "execute_code",
  ];

  beforeEach(() => {
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
    filter = new SessionToolFilter(eventBus, logger);
  });

  describe("filter (no drain)", () => {
    it("returns all tools when no policy restrictions", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
      });

      const result = filter.filter(policy, "sess-1", allTools, null);
      expect(result).toEqual(allTools);
    });

    it("returns only allowlisted tools", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        allowedTools: ["read_file", "write_file", "context_status"],
      });

      const result = filter.filter(policy, "sess-1", allTools, null);

      expect(result).toEqual([
        "context_status",
        "read_file",
        "write_file",
      ]);
      expect(result).not.toContain("terminal");
      expect(result).not.toContain("web_search");
    });

    it("excludes denied tools", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        deniedTools: ["terminal", "execute_code"],
      });

      const result = filter.filter(policy, "sess-1", allTools, null);

      expect(result).not.toContain("terminal");
      expect(result).not.toContain("execute_code");
      expect(result).toContain("read_file");
      expect(result).toContain("write_file");
    });
  });

  describe("filter (with drain)", () => {
    it("reduces tools to essentials only when drain is active", () => {
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

      const result = filter.filter(policy, "sess-1", allTools, drainManager);

      expect(result).toEqual([
        "context_status",
        "post_structured_completion",
      ]);
      expect(result).not.toContain("read_file");
      expect(result).not.toContain("terminal");
    });

    it("combines allowlist + drain filtering", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        allowedTools: [
          "read_file",
          "context_status",
          "post_structured_completion",
        ],
      });
      const drainManager = new DrainModeManager(
        eventBus,
        logger,
        "sess-1",
        policy,
      );
      drainManager.activate("iteration_budget");

      const result = filter.filter(
        policy,
        "sess-1",
        ["read_file", "context_status", "post_structured_completion"],
        drainManager,
      );

      expect(result).toEqual([
        "context_status",
        "post_structured_completion",
      ]);
      expect(result).not.toContain("read_file");
    });

    it("preserves extra essential tools during drain", () => {
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
      drainManager.addEssentialTool("notify_user");
      drainManager.activate("iteration_budget");

      const tools = [
        "context_status",
        "post_structured_completion",
        "notify_user",
        "terminal",
      ];

      const result = filter.filter(policy, "sess-1", tools, drainManager);

      expect(result).toEqual([
        "context_status",
        "post_structured_completion",
        "notify_user",
      ]);
    });
  });

  describe("isAllowed", () => {
    it("returns true for unrestricted tool", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
      });

      expect(filter.isAllowed(policy, "sess-1", "read_file", null)).toBe(
        true,
      );
    });

    it("returns false for denied tool", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        deniedTools: ["terminal"],
      });

      expect(filter.isAllowed(policy, "sess-1", "terminal", null)).toBe(
        false,
      );
    });

    it("returns false for non-essential tool during drain", () => {
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

      expect(
        filter.isAllowed(policy, "sess-1", "terminal", drainManager),
      ).toBe(false);
    });

    it("returns true for essential tool during drain", () => {
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

      expect(
        filter.isAllowed(
          policy,
          "sess-1",
          "context_status",
          drainManager,
        ),
      ).toBe(true);
    });
  });

  describe("getEnforcer", () => {
    it("returns the underlying enforcer", () => {
      const enforcer = filter.getEnforcer();
      expect(enforcer).toBeDefined();
      expect(typeof enforcer.checkTool).toBe("function");
    });
  });
});
