/**
 * Tests for ToolPolicyEnforcer — allowlist/denylist enforcement.
 *
 * @module pi-tools/__tests__/tool-policy-enforcer.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeEventBus, FakeLogger, ToolDeniedError } from "@pi-crew/core";
import { createExecutionPolicy, createWorkerPolicy } from "../execution-policy.js";
import { ToolPolicyEnforcer } from "../tool-policy-enforcer.js";

describe("ToolPolicyEnforcer", () => {
  let eventBus: FakeEventBus;
  let logger: FakeLogger;
  let enforcer: ToolPolicyEnforcer;

  beforeEach(() => {
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
    enforcer = new ToolPolicyEnforcer(eventBus, logger);
  });

  describe("checkTool", () => {
    it("allows any tool when allowlist and denylist are empty", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
      });

      const result = enforcer.checkTool(policy, "read_file", "sess-1");
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("");
    });

    it("supports a non-worker execution policy", () => {
      const policy = createExecutionPolicy({
        policyId: "session-policy-1",
        rootPath: "/tmp/session",
        allowedTools: ["read_file"],
      });

      const result = enforcer.checkTool(policy, "read_file", "sess-1");
      expect(result.allowed).toBe(true);

      const denied = enforcer.checkTool(policy, "terminal", "sess-1");
      expect(denied.allowed).toBe(false);
      const enforced = eventBus.emitted.filter((e) => e.event === "policy.enforced");
      expect(enforced[0]?.payload).toMatchObject({
        policyId: "session-policy-1",
        assignmentId: undefined,
      });
    });

    it("denies tools in the denylist", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        deniedTools: ["terminal", "execute_code"],
      });

      const result = enforcer.checkTool(policy, "terminal", "sess-1");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("explicitly denied");
    });

    it("allows tools not in the denylist when allowlist is empty", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        deniedTools: ["terminal"],
      });

      const result = enforcer.checkTool(policy, "read_file", "sess-1");
      expect(result.allowed).toBe(true);
    });

    it("only allows tools in the allowlist when non-empty", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        allowedTools: ["read_file", "write_file"],
      });

      expect(enforcer.checkTool(policy, "read_file", "sess-1").allowed).toBe(
        true,
      );
      expect(enforcer.checkTool(policy, "write_file", "sess-1").allowed).toBe(
        true,
      );
      expect(enforcer.checkTool(policy, "terminal", "sess-1").allowed).toBe(
        false,
      );
    });

    it("denylist takes precedence over allowlist", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        allowedTools: ["read_file", "terminal"],
        deniedTools: ["terminal"],
      });

      const result = enforcer.checkTool(policy, "terminal", "sess-1");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("explicitly denied");
    });

    it("emits tool.denied event when a tool is denied", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        deniedTools: ["terminal"],
      });

      enforcer.checkTool(policy, "terminal", "sess-1");

      const deniedEvents = eventBus.emitted.filter(
        (e) => e.event === "tool.denied",
      );
      expect(deniedEvents.length).toBeGreaterThanOrEqual(1);
      expect(deniedEvents[0]?.payload).toMatchObject({
        toolName: "terminal",
        sessionId: "sess-1",
      });
    });

    it("emits policy.enforced event on every check", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
      });

      enforcer.checkTool(policy, "read_file", "sess-1");

      const enforced = eventBus.emitted.filter(
        (e) => e.event === "policy.enforced",
      );
      expect(enforced.length).toBeGreaterThanOrEqual(1);
      expect(enforced[0]?.payload).toMatchObject({
        checkKind: "tool",
        allowed: true,
      });
    });
  });

  describe("requireTool", () => {
    it("does not throw for allowed tools", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        allowedTools: ["read_file"],
      });

      expect(() => {
        enforcer.requireTool(policy, "read_file", "sess-1");
      }).not.toThrow();
    });

    it("throws ToolDeniedError for denied tools", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        deniedTools: ["terminal"],
      });

      expect(() => {
        enforcer.requireTool(policy, "terminal", "sess-1");
      }).toThrow(ToolDeniedError);
    });

    it("ToolDeniedError carries the tool name", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        deniedTools: ["dangerous_tool"],
      });

      try {
        enforcer.requireTool(policy, "dangerous_tool", "sess-1");
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ToolDeniedError);
        const te = err as ToolDeniedError;
        expect(te.toolName).toBe("dangerous_tool");
        expect(te.code).toBe("TOOL_DENIED_ERROR");
      }
    });
  });

  describe("filterToolNames", () => {
    it("returns only allowed tools", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        allowedTools: ["read_file", "write_file"],
      });

      const result = enforcer.filterToolNames(
        policy,
        ["read_file", "write_file", "terminal", "execute_code"],
        "sess-1",
      );

      expect(result).toEqual(["read_file", "write_file"]);
    });

    it("returns all tools when no restrictions", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
      });

      const result = enforcer.filterToolNames(
        policy,
        ["read_file", "write_file", "terminal"],
        "sess-1",
      );

      expect(result).toEqual(["read_file", "write_file", "terminal"]);
    });

    it("excludes denied tools even if allowlist is empty", () => {
      const policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        deniedTools: ["terminal"],
      });

      const result = enforcer.filterToolNames(
        policy,
        ["read_file", "terminal"],
        "sess-1",
      );

      expect(result).toEqual(["read_file"]);
    });
  });
});
