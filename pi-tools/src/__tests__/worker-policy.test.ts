/**
 * Tests for WorkerPolicy factory and validation.
 *
 * @module pi-tools/__tests__/worker-policy.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createWorkerPolicy,
  isPathAllowed,
  isHostAllowed,
  isIterationBudgetExhausted,
  isIterationBudgetLow,
} from "../worker-policy.js";

describe("createWorkerPolicy", () => {
  const minimalInput = {
    assignmentId: "42",
    runId: "run-1",
    taskId: "1867",
    role: "coder",
  };

  it("creates a policy with sensible defaults", () => {
    const policy = createWorkerPolicy(minimalInput);

    expect(policy.assignmentId).toBe("42");
    expect(policy.role).toBe("coder");
    expect(policy.workdir).toBe("/tmp/pi-worker");
    expect(policy.allowedTools).toEqual([]);
    expect(policy.deniedTools).toEqual([]);
    expect(policy.allowedPaths).toEqual([]);
    expect(policy.denyPaths).toEqual([]);
    expect(policy.maxDurationMs).toBe(30 * 60 * 1000);
    expect(policy.maxTurnDurationMs).toBe(5 * 60 * 1000);
    expect(policy.idleTimeoutMs).toBe(10 * 60 * 1000);
    expect(policy.maxIterations).toBe(50);
    expect(policy.maxTokensPerTurn).toBe(128_000);
    expect(policy.credentialScope).toBe("none");
    expect(policy.releaseOnCompletion).toBe(true);
    expect(policy.cleanupWorkdir).toBe(true);
  });

  it("accepts overrides for all fields", () => {
    const policy = createWorkerPolicy({
      ...minimalInput,
      workdir: "/opt/task-42",
      allowedPaths: ["/opt/task-42/src"],
      denyPaths: ["/opt/task-42/secrets"],
      allowedTools: ["read_file", "write_file"],
      deniedTools: ["terminal"],
      allowedHosts: ["api.example.com"],
      deniedHosts: ["evil.com"],
      maxDurationMs: 600_000,
      maxTurnDurationMs: 120_000,
      idleTimeoutMs: 300_000,
      maxIterations: 100,
      maxTokensPerTurn: 256_000,
      credentialScope: "bounded_write",
      releaseOnCompletion: false,
      cleanupWorkdir: false,
    });

    expect(policy.workdir).toBe("/opt/task-42");
    expect(policy.allowedPaths).toEqual(["/opt/task-42/src"]);
    expect(policy.denyPaths).toEqual(["/opt/task-42/secrets"]);
    expect(policy.allowedTools).toEqual(["read_file", "write_file"]);
    expect(policy.deniedTools).toEqual(["terminal"]);
    expect(policy.maxDurationMs).toBe(600_000);
    expect(policy.credentialScope).toBe("bounded_write");
    expect(policy.releaseOnCompletion).toBe(false);
    expect(policy.cleanupWorkdir).toBe(false);
  });
});

describe("isPathAllowed", () => {
  let policy: ReturnType<typeof createWorkerPolicy>;

  describe("when allowlist is empty (workdir-only)", () => {
    beforeEach(() => {
      policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        workdir: "/opt/task",
      });
    });

    it("allows paths within the workdir", () => {
      expect(isPathAllowed(policy, "/opt/task/src/main.ts")).toBe(true);
      expect(isPathAllowed(policy, "/opt/task/data/config.json")).toBe(true);
    });

    it("denies paths outside workdir", () => {
      expect(isPathAllowed(policy, "/etc/passwd")).toBe(false);
    });
  });

  describe("when allowlist is explicit", () => {
    beforeEach(() => {
      policy = createWorkerPolicy({
        assignmentId: "1",
        runId: "r1",
        taskId: "1",
        role: "coder",
        workdir: "/opt/task",
        allowedPaths: ["/opt/task/src", "/tmp/shared"],
        denyPaths: ["/opt/task/src/secrets"],
      });
    });

    it("allows paths in the explicit allowlist", () => {
      expect(isPathAllowed(policy, "/opt/task/src/main.ts")).toBe(true);
      expect(isPathAllowed(policy, "/tmp/shared/data.bin")).toBe(true);
    });

    it("denies paths not in explicit allowlist even if under workdir", () => {
      expect(isPathAllowed(policy, "/opt/task/data/config.json")).toBe(false);
      expect(isPathAllowed(policy, "/opt/task/logs/app.log")).toBe(false);
    });

    it("denies paths in explicit denyPaths", () => {
      expect(isPathAllowed(policy, "/opt/task/src/secrets/key.pem")).toBe(false);
    });

    it("allows relative paths resolved under an explicit allowlist root", () => {
      expect(isPathAllowed(policy, "src/main.ts")).toBe(true);
    });

    it("denies traversal that escapes an explicit allowlist root", () => {
      expect(isPathAllowed(policy, "../task-private/key.pem")).toBe(false);
    });

    it("denies sibling prefixes that only start with an allowed path string", () => {
      expect(isPathAllowed(policy, "/opt/task/src-not-allowed/file.ts")).toBe(false);
    });
  });
});

describe("isHostAllowed", () => {
  const policy = createWorkerPolicy({
    assignmentId: "1",
    runId: "r1",
    taskId: "1",
    role: "coder",
    allowedHosts: ["api.example.com", "github.com"],
    deniedHosts: ["evil.com", "malware.org"],
  });

  it("allows hosts in the allowlist", () => {
    expect(isHostAllowed(policy, "api.example.com")).toBe(true);
    expect(isHostAllowed(policy, "github.com")).toBe(true);
  });

  it("allows subdomains of allowed hosts", () => {
    expect(isHostAllowed(policy, "v2.api.example.com")).toBe(true);
  });

  it("denies hosts in the denylist", () => {
    expect(isHostAllowed(policy, "evil.com")).toBe(false);
    expect(isHostAllowed(policy, "sub.evil.com")).toBe(false);
  });

  it("allows any host when allowlist is empty", () => {
    const openPolicy = createWorkerPolicy({
      assignmentId: "2",
      runId: "r2",
      taskId: "2",
      role: "coder",
    });
    expect(isHostAllowed(openPolicy, "random-site.com")).toBe(true);
  });

  it("denies blocked hosts even with an empty allowlist", () => {
    const denyOnly = createWorkerPolicy({
      assignmentId: "3",
      runId: "r3",
      taskId: "3",
      role: "coder",
      deniedHosts: ["evil.com"],
    });
    expect(isHostAllowed(denyOnly, "evil.com")).toBe(false);
    expect(isHostAllowed(denyOnly, "safe.com")).toBe(true);
  });
});

describe("isIterationBudgetExhausted", () => {
  const policy = createWorkerPolicy({
    assignmentId: "1",
    runId: "r1",
    taskId: "1",
    role: "coder",
    maxIterations: 50,
  });

  it("returns false when budget is not exhausted", () => {
    expect(isIterationBudgetExhausted(policy, 0)).toBe(false);
    expect(isIterationBudgetExhausted(policy, 49)).toBe(false);
  });

  it("returns true when budget is exhausted", () => {
    expect(isIterationBudgetExhausted(policy, 50)).toBe(true);
    expect(isIterationBudgetExhausted(policy, 99)).toBe(true);
  });
});

describe("isIterationBudgetLow", () => {
  const policy = createWorkerPolicy({
    assignmentId: "1",
    runId: "r1",
    taskId: "1",
    role: "coder",
    maxIterations: 50,
  });

  it("returns false for low iteration counts", () => {
    expect(isIterationBudgetLow(policy, 0)).toBe(false);
    expect(isIterationBudgetLow(policy, 35)).toBe(false);
  });

  it("returns true when budget is at 80%", () => {
    expect(isIterationBudgetLow(policy, 40)).toBe(true);
    expect(isIterationBudgetLow(policy, 45)).toBe(true);
  });
});
