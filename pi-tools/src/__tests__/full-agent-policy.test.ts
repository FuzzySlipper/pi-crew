import { describe, expect, it } from "vitest";

import { FakeEventBus, FakeLogger } from "@pi-crew/core";

import {
  createFullAgentPolicy,
  WORKER_ONLY_TOOLS,
  isWorkerOnlyTool,
  SessionToolFilter,
} from "../index.js";

describe("createFullAgentPolicy", () => {
  it("creates a policy with fullAgent defaults", () => {
    const policy = createFullAgentPolicy({ policyId: "conv-test-1" });
    expect(policy.policyId).toBe("conv-test-1");
    expect(policy.rootPath).toBe("/tmp/pi-conversation");
    expect(policy.maxDurationMs).toBe(60 * 60 * 1000);
    expect(policy.maxTurnDurationMs).toBe(10 * 60 * 1000);
    expect(policy.maxIterations).toBe(100);
    expect(policy.credentialScope).toBe("none");
  });

  it("always denies worker-only tools even if caller passes empty deniedTools", () => {
    const policy = createFullAgentPolicy({ policyId: "conv-test-2" });
    for (const tool of WORKER_ONLY_TOOLS) {
      expect(policy.deniedTools).toContain(tool);
    }
  });

  it("merges caller denied tools with worker-only tools", () => {
    const policy = createFullAgentPolicy({
      policyId: "conv-test-3",
      deniedTools: ["my_custom_tool"],
    });
    expect(policy.deniedTools).toContain("my_custom_tool");
    expect(policy.deniedTools).toContain("post_structured_completion");
    expect(policy.deniedTools).toContain("release_assignment");
  });

  it("does not duplicate denied tools", () => {
    const policy = createFullAgentPolicy({
      policyId: "conv-test-4",
      deniedTools: ["post_structured_completion"],
    });
    const pscCount = policy.deniedTools.filter((t) => t === "post_structured_completion").length;
    expect(pscCount).toBe(1);
  });

  it("applies caller overrides for paths, hosts, and budget", () => {
    const policy = createFullAgentPolicy({
      policyId: "conv-test-5",
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

describe("WORKER_ONLY_TOOLS", () => {
  it("contains post_structured_completion", () => {
    expect(WORKER_ONLY_TOOLS.has("post_structured_completion")).toBe(true);
  });

  it("contains context_status", () => {
    expect(WORKER_ONLY_TOOLS.has("context_status")).toBe(true);
  });

  it("contains release_assignment", () => {
    expect(WORKER_ONLY_TOOLS.has("release_assignment")).toBe(true);
  });

  it("contains request_checkpoint", () => {
    expect(WORKER_ONLY_TOOLS.has("request_checkpoint")).toBe(true);
  });

  it("contains record_cleanup_evidence", () => {
    expect(WORKER_ONLY_TOOLS.has("record_cleanup_evidence")).toBe(true);
  });
});

describe("isWorkerOnlyTool", () => {
  it("returns true for worker-only tools", () => {
    expect(isWorkerOnlyTool("post_structured_completion")).toBe(true);
    expect(isWorkerOnlyTool("context_status")).toBe(true);
    expect(isWorkerOnlyTool("release_assignment")).toBe(true);
  });

  it("returns false for ordinary tools", () => {
    expect(isWorkerOnlyTool("web_search")).toBe(false);
    expect(isWorkerOnlyTool("mcp_den_get_task")).toBe(false);
    expect(isWorkerOnlyTool("read_file")).toBe(false);
  });
});

describe("SessionToolFilter with fullAgent policy", () => {
  it("denies worker-only tools through the filter", () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    const policy = createFullAgentPolicy({ policyId: "conv-filter-1" });
    const allTools = [
      "web_search",
      "read_file",
      "post_structured_completion",
      "context_status",
      "release_assignment",
      "mcp_den_get_task",
    ];

    const allowed = filter.filter(policy, "sess-1", allTools, null);
    expect(allowed).not.toContain("post_structured_completion");
    expect(allowed).not.toContain("context_status");
    expect(allowed).not.toContain("release_assignment");
    expect(allowed).toContain("web_search");
    expect(allowed).toContain("read_file");
    expect(allowed).toContain("mcp_den_get_task");
  });

  it("emits tool.denied events when worker-only tools are filtered", () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    const policy = createFullAgentPolicy({ policyId: "conv-filter-2" });
    filter.filter(policy, "sess-2", ["post_structured_completion", "read_file"], null);

    const denied = eventBus.emitted.filter(
      (e) => e.event === "tool.denied",
    );
    expect(denied.length).toBeGreaterThan(0);
  });

  it("isAllowed returns false for worker-only tools", () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    const policy = createFullAgentPolicy({ policyId: "conv-filter-3" });
    expect(filter.isAllowed(policy, "sess-3", "post_structured_completion", null)).toBe(false);
    expect(filter.isAllowed(policy, "sess-3", "release_assignment", null)).toBe(false);
  });

  it("isAllowed returns true for ordinary tools", () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    const policy = createFullAgentPolicy({ policyId: "conv-filter-4" });
    expect(filter.isAllowed(policy, "sess-4", "web_search", null)).toBe(true);
    expect(filter.isAllowed(policy, "sess-4", "read_file", null)).toBe(true);
  });

  it("respects caller-specified denied tools beyond worker-only set", () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const filter = new SessionToolFilter(eventBus, logger);

    const policy = createFullAgentPolicy({
      policyId: "conv-filter-5",
      deniedTools: ["dangerous_tool"],
    });
    const allowed = filter.filter(
      policy,
      "sess-5",
      ["web_search", "dangerous_tool", "post_structured_completion"],
      null,
    );
    expect(allowed).not.toContain("dangerous_tool");
    expect(allowed).not.toContain("post_structured_completion");
    expect(allowed).toContain("web_search");
  });
});
