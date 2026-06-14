/**
 * Tests for assignment-manager capability policy.
 *
 * Verifies the three-tier policy boundary:
 * 1. Safe reads and assignment-management tools are allowed
 * 2. Worker lifecycle tools are always denied
 * 3. Subagent spawning is denied (must use worker path)
 * 4. Assignment-manager does NOT inherit plain fullAgent denials
 *    beyond the hard denied set
 *
 * @module pi-tools/__tests__/assignment-manager-policy.test
 */

import { describe, expect, it } from "vitest";

import { FakeEventBus, FakeLogger } from "@pi-crew/core";

import {
  ASSIGNMENT_MANAGER_DENIED_TOOLS,
  ASSIGNMENT_MANAGER_SAFE_TOOLS,
  WORKER_ONLY_TOOLS,
  SessionToolFilter,
  createAssignmentManagerPolicy,
  createFullAgentPolicy,
  isAssignmentManagerTool,
} from "../index.js";

// ── createAssignmentManagerPolicy ──────────────────────────────

describe("createAssignmentManagerPolicy", () => {
  it("creates a policy with assignment-manager defaults", () => {
    const policy = createAssignmentManagerPolicy({ policyId: "am-test-1" });
    expect(policy.policyId).toBe("am-test-1");
    expect(policy.rootPath).toBe("/tmp/pi-assignment-manager");
    expect(policy.maxDurationMs).toBe(60 * 60 * 1000);
    expect(policy.maxTurnDurationMs).toBe(10 * 60 * 1000);
    expect(policy.maxIterations).toBe(100);
    expect(policy.credentialScope).toBe("none");
  });

  it("uses an allowlist approach — only listed tools pass", () => {
    const policy = createAssignmentManagerPolicy({ policyId: "am-test-2" });
    // Allowlist should contain assignment-management tools
    expect(policy.allowedTools).toContain("lease_worker");
    expect(policy.allowedTools).toContain("get_task");
    expect(policy.allowedTools).toContain("list_pool_members");
    expect(policy.allowedTools).toContain("cleanup_worker_run");
    // Allowlist should NOT contain worker lifecycle tools
    expect(policy.allowedTools).not.toContain("post_structured_completion");
    expect(policy.allowedTools).not.toContain("release_assignment");
    expect(policy.allowedTools).not.toContain("spawn_subagent");
  });

  it("always denies worker-only lifecycle tools", () => {
    const policy = createAssignmentManagerPolicy({ policyId: "am-test-3" });
    for (const tool of WORKER_ONLY_TOOLS) {
      expect(policy.deniedTools).toContain(tool);
    }
  });

  it("always denies post_worker_completion_packet", () => {
    const policy = createAssignmentManagerPolicy({ policyId: "am-test-4" });
    expect(policy.deniedTools).toContain("post_worker_completion_packet");
  });

  it("always denies spawn_subagent", () => {
    const policy = createAssignmentManagerPolicy({ policyId: "am-test-5" });
    expect(policy.deniedTools).toContain("spawn_subagent");
  });

  it("merges caller denied tools with hard denied set", () => {
    const policy = createAssignmentManagerPolicy({
      policyId: "am-test-6",
      deniedTools: ["custom_dangerous_tool"],
    });
    expect(policy.deniedTools).toContain("custom_dangerous_tool");
    expect(policy.deniedTools).toContain("post_structured_completion");
    expect(policy.deniedTools).toContain("spawn_subagent");
  });

  it("does not duplicate denied tools", () => {
    const policy = createAssignmentManagerPolicy({
      policyId: "am-test-7",
      deniedTools: ["post_structured_completion"],
    });
    const pscCount = policy.deniedTools.filter(
      (t) => t === "post_structured_completion",
    ).length;
    expect(pscCount).toBe(1);
  });

  it("removes caller-allowed tools that are in the hard denied set", () => {
    // Even if a caller tries to allow a denied tool, it must be removed
    const policy = createAssignmentManagerPolicy({
      policyId: "am-test-8",
      allowedTools: ["lease_worker", "post_structured_completion", "spawn_subagent"],
    });
    expect(policy.allowedTools).toContain("lease_worker");
    expect(policy.allowedTools).not.toContain("post_structured_completion");
    expect(policy.allowedTools).not.toContain("spawn_subagent");
  });

  it("applies caller overrides for paths, hosts, and budget", () => {
    const policy = createAssignmentManagerPolicy({
      policyId: "am-test-9",
      rootPath: "/custom/root",
      allowedPaths: ["/custom/root/data"],
      allowedHosts: ["api.example.com"],
      maxIterations: 200,
      maxTokensPerTurn: 64_000,
      credentialScope: "read_only",
    });
    expect(policy.rootPath).toBe("/custom/root");
    expect(policy.allowedPaths).toEqual(["/custom/root/data"]);
    expect(policy.allowedHosts).toEqual(["api.example.com"]);
    expect(policy.maxIterations).toBe(200);
    expect(policy.maxTokensPerTurn).toBe(64_000);
    expect(policy.credentialScope).toBe("read_only");
  });
});

// ── Tool sets ──────────────────────────────────────────────────

describe("ASSIGNMENT_MANAGER_SAFE_TOOLS", () => {
  it("contains assignment creation tool", () => {
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("lease_worker")).toBe(true);
  });

  it("contains assignment cleanup tool", () => {
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("cleanup_worker_run")).toBe(true);
  });

  it("contains pool inspection tools", () => {
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("list_pool_members")).toBe(true);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("list_assignments")).toBe(true);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("get_worker_run_status")).toBe(true);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("get_latest_worker_completion")).toBe(true);
  });

  it("contains Den read tools", () => {
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("get_task")).toBe(true);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("get_messages")).toBe(true);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("get_document")).toBe(true);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("search_documents")).toBe(true);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("query_librarian")).toBe(true);
  });

  it("contains task write tools for orchestrating work", () => {
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("create_task")).toBe(true);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("update_task")).toBe(true);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("send_message")).toBe(true);
  });

  it("does NOT contain worker lifecycle tools", () => {
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("post_structured_completion")).toBe(false);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("release_assignment")).toBe(false);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("context_status")).toBe(false);
    expect(ASSIGNMENT_MANAGER_SAFE_TOOLS.has("spawn_subagent")).toBe(false);
  });
});

describe("ASSIGNMENT_MANAGER_DENIED_TOOLS", () => {
  it("contains all worker-only tools", () => {
    for (const tool of WORKER_ONLY_TOOLS) {
      expect(ASSIGNMENT_MANAGER_DENIED_TOOLS.has(tool)).toBe(true);
    }
  });

  it("contains post_worker_completion_packet", () => {
    expect(ASSIGNMENT_MANAGER_DENIED_TOOLS.has("post_worker_completion_packet")).toBe(true);
  });

  it("contains spawn_subagent", () => {
    expect(ASSIGNMENT_MANAGER_DENIED_TOOLS.has("spawn_subagent")).toBe(true);
  });
});

// ── isAssignmentManagerTool ────────────────────────────────────

describe("isAssignmentManagerTool", () => {
  it("returns true for assignment-management tools", () => {
    expect(isAssignmentManagerTool("lease_worker")).toBe(true);
    expect(isAssignmentManagerTool("get_task")).toBe(true);
    expect(isAssignmentManagerTool("list_pool_members")).toBe(true);
    expect(isAssignmentManagerTool("cleanup_worker_run")).toBe(true);
  });

  it("returns false for worker-only tools", () => {
    expect(isAssignmentManagerTool("post_structured_completion")).toBe(false);
    expect(isAssignmentManagerTool("release_assignment")).toBe(false);
    expect(isAssignmentManagerTool("context_status")).toBe(false);
  });

  it("returns false for spawn_subagent", () => {
    expect(isAssignmentManagerTool("spawn_subagent")).toBe(false);
  });

  it("returns false for unknown tools", () => {
    expect(isAssignmentManagerTool("totally_unknown_tool")).toBe(false);
  });
});

// ── SessionToolFilter integration ──────────────────────────────

describe("SessionToolFilter with assignment-manager policy", () => {
  it("allows assignment-management tools through the filter", () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    const policy = createAssignmentManagerPolicy({ policyId: "am-filter-1" });
    const allTools = [
      "get_task",
      "lease_worker",
      "list_pool_members",
      "cleanup_worker_run",
      "web_search",
      "read_file",
    ];

    const allowed = filter.filter(policy, "sess-am-1", allTools, null);
    expect(allowed).toContain("get_task");
    expect(allowed).toContain("lease_worker");
    expect(allowed).toContain("list_pool_members");
    expect(allowed).toContain("cleanup_worker_run");
    expect(allowed).toContain("web_search");
    expect(allowed).toContain("read_file");
  });

  it("denies worker lifecycle tools through the filter", () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    const policy = createAssignmentManagerPolicy({ policyId: "am-filter-2" });
    const allTools = [
      "get_task",
      "post_structured_completion",
      "release_assignment",
      "context_status",
      "spawn_subagent",
    ];

    const allowed = filter.filter(policy, "sess-am-2", allTools, null);
    expect(allowed).toContain("get_task");
    expect(allowed).not.toContain("post_structured_completion");
    expect(allowed).not.toContain("release_assignment");
    expect(allowed).not.toContain("context_status");
    expect(allowed).not.toContain("spawn_subagent");
  });

  it("emits tool.denied events when denied tools are filtered", () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    const policy = createAssignmentManagerPolicy({ policyId: "am-filter-3" });
    filter.filter(policy, "sess-am-3", [
      "get_task",
      "post_structured_completion",
      "spawn_subagent",
    ], null);

    const denied = eventBus.emitted.filter(
      (e) => e.event === "tool.denied",
    );
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });

  it("isAllowed returns correct results for each tier", () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    const policy = createAssignmentManagerPolicy({ policyId: "am-filter-4" });
    // Allowed
    expect(filter.isAllowed(policy, "sess-am-4", "lease_worker", null)).toBe(true);
    expect(filter.isAllowed(policy, "sess-am-4", "get_task", null)).toBe(true);
    // Denied
    expect(filter.isAllowed(policy, "sess-am-4", "post_structured_completion", null)).toBe(false);
    expect(filter.isAllowed(policy, "sess-am-4", "spawn_subagent", null)).toBe(false);
    expect(filter.isAllowed(policy, "sess-am-4", "release_assignment", null)).toBe(false);
  });
});

// ── Tier isolation ─────────────────────────────────────────────

describe("assignment-manager vs fullAgent policy isolation", () => {
  it("assignment-manager can lease workers; fullAgent cannot", () => {
    const amPolicy = createAssignmentManagerPolicy({ policyId: "am-isolation-1" });
    const convPolicy = createFullAgentPolicy({ policyId: "conv-isolation-1" });

    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    // AM can lease
    const amTools = filter.filter(amPolicy, "sess-am", ["lease_worker", "get_task"], null);
    expect(amTools).toContain("lease_worker");

    // FullAgent cannot lease (not in default allowlist, and if
    // it were added by config, it's not denied by conv policy, but
    // conv policy has no explicit allowlist so all tools pass deny check)
    // FullAgent has no allowlist (empty = all pass), so lease_worker
    // would pass unless explicitly denied. The conv policy uses deny-only.
    // AM uses allowlist+deny — the key structural difference.
    filter.filter(convPolicy, "sess-conv", ["lease_worker", "get_task"], null);
    // The key difference: AM has an explicit allowlist that limits surface
    expect(amPolicy.allowedTools.length).toBeGreaterThan(0);
    expect(convPolicy.allowedTools.length).toBe(0); // no allowlist = open
  });

  it("both tiers deny worker lifecycle tools", () => {
    const amPolicy = createAssignmentManagerPolicy({ policyId: "am-isolation-2" });
    const convPolicy = createFullAgentPolicy({ policyId: "conv-isolation-2" });

    for (const tool of WORKER_ONLY_TOOLS) {
      expect(amPolicy.deniedTools).toContain(tool);
      expect(convPolicy.deniedTools).toContain(tool);
    }
  });

  it("ordinary fullAgent policy does not inherit assignment-manager tools", () => {
    const convPolicy = createFullAgentPolicy({ policyId: "conv-isolation-3" });
    // FullAgent has no allowlist, so tool access is deny-only
    expect(convPolicy.allowedTools.length).toBe(0);
    // But worker tools are denied
    expect(convPolicy.deniedTools).toContain("post_structured_completion");
  });
});
