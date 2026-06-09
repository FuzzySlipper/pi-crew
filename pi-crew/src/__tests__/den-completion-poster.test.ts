/**
 * Tests for DenCompletionPoster — the CompletionPoster that calls
 * Den Core's post_worker_completion_packet MCP tool.
 *
 * @module pi-crew/__tests__/den-completion-poster.test
 */

import { describe, it, expect, vi } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import type { CompletionPacket } from "@pi-crew/core";
import type { MCPClient, ToolCallResult } from "@pi-crew/mcp";
import { createDenCompletionPoster } from "../den-completion-poster.js";

// ── Test helpers ──────────────────────────────────────────────

function makeValidPacket(overrides?: Partial<CompletionPacket>): CompletionPacket {
  return {
    assignmentId: "42",
    runId: "run-test-1",
    taskId: "2061",
    status: "completed",
    role: "coder",
    artifacts: [{ type: "pr", ref: "abc123", summary: "Test PR" }],
    filesTouched: ["src/foo.ts"],
    toolsUsed: ["read_file"],
    tokensConsumed: 1000,
    durationMs: 5000,
    turnCount: 1,
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOkResult(text?: string): ToolCallResult {
  return {
    ok: true,
    content: [{ type: "text", text: text ?? "Packet posted" }],
  };
}

function makeFailResult(error: string): ToolCallResult {
  return {
    ok: false,
    content: [],
    error,
  };
}

interface StubMcpClient {
  callToolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  mcpClient: MCPClient;
}

function makeStubMcpClient(responses: ToolCallResult[], throws?: Error[]): StubMcpClient {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  let callIndex = 0;

  const mockCallTool =
    vi.fn<(name: string, params: Record<string, unknown>) => Promise<ToolCallResult>>();
  mockCallTool.mockImplementation((name: string, params: Record<string, unknown>) => {
    calls.push({ name, params });
    const idx = callIndex;
    callIndex = callIndex + 1;

    if (throws && idx < throws.length && throws[idx]) {
      return Promise.reject(throws[idx]);
    }

    return Promise.resolve(responses[idx] ?? makeOkResult());
  });

  return {
    callToolCalls: calls,
    mcpClient: {
      callTool: mockCallTool,
    } as unknown as MCPClient,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("createDenCompletionPoster", () => {
  it("calls post_worker_completion_packet with correct params for a valid packet", async () => {
    const { mcpClient, callToolCalls } = makeStubMcpClient([makeOkResult()]);
    const poster = createDenCompletionPoster({
      mcpClient,
      projectId: "pi-crew",
      requestedBy: "test-agent",
    });

    const packet = makeValidPacket();
    const result = await poster(packet);

    expect(result.accepted).toBe(true);
    expect(callToolCalls.length).toBe(1);
    expect(callToolCalls[0]?.name).toBe("post_worker_completion_packet");

    const params = callToolCalls[0]?.params;
    expect(params).toBeDefined();
    if (params) {
      expect(params.project_id).toBe("pi-crew");
      expect(params.run_id).toBe("run-test-1");
      expect(params.requested_by).toBe("test-agent");
      expect(params.status).toBe("completed");
      expect(params.role).toBe("coder");
      expect(params.packet_type).toBe("implementation_packet");
      expect(typeof params.summary).toBe("string");
      expect((params.summary as string).length).toBeGreaterThan(0);
    }
  });

  it("adds configured repo/test metadata defaults when packet lacks them", async () => {
    const { mcpClient, callToolCalls } = makeStubMcpClient([makeOkResult()]);
    const poster = createDenCompletionPoster({
      mcpClient,
      projectId: "pi-crew",
      requestedBy: "test-agent",
      completionDefaults: {
        branch: "task/2185-live-smoke-fix",
        baseCommit: "base-sha",
        headCommit: "head-sha",
        testsRun: ["live smoke completed"],
      },
    });

    await poster(makeValidPacket());

    expect(callToolCalls[0]?.params).toMatchObject({
      branch: "task/2185-live-smoke-fix",
      base_commit: "base-sha",
      head_commit: "head-sha",
      tests_run: '["live smoke completed"]',
    });
  });

  it("maps non-coder worker roles to the canonical Den packet type", async () => {
    const { mcpClient, callToolCalls } = makeStubMcpClient([
      makeOkResult(),
      makeOkResult(),
      makeOkResult(),
      makeOkResult(),
    ]);
    const poster = createDenCompletionPoster({
      mcpClient,
      projectId: "pi-crew",
      requestedBy: "test-agent",
    });

    await poster(makeValidPacket({ role: "reviewer" }));
    await poster(makeValidPacket({ role: "validator" }));
    await poster(makeValidPacket({ role: "drift_checker" }));
    await poster(makeValidPacket({ role: "packet-auditor" }));

    expect(callToolCalls.map((call) => call.params.packet_type)).toEqual([
      "review_findings_packet",
      "validation_packet",
      "drift_check_packet",
      "packet_audit_packet",
    ]);
  });

  it("returns accepted:false when Den rejects the packet", async () => {
    const { mcpClient } = makeStubMcpClient([makeFailResult("Invalid status value")]);
    const poster = createDenCompletionPoster({
      mcpClient,
      projectId: "pi-crew",
      requestedBy: "test-agent",
    });

    const packet = makeValidPacket({ status: "completed" });
    const result = await poster(packet);

    expect(result.accepted).toBe(false);
    expect(result.message).toContain("Invalid status value");
  });

  it("retries on MCP errors and returns accepted:false after exhausting retries", async () => {
    const networkError = new Error("ECONNREFUSED");
    const { mcpClient, callToolCalls } = makeStubMcpClient(
      [],
      [networkError, networkError, networkError],
    );
    const logger = new FakeLogger();
    const poster = createDenCompletionPoster({
      mcpClient,
      projectId: "pi-crew",
      requestedBy: "test-agent",
      logger,
    });

    const packet = makeValidPacket();
    const result = await poster(packet);

    expect(result.accepted).toBe(false);
    expect(result.message).toContain("unavailable");

    // Should have tried 3 times (1 initial + 2 retries)
    expect(callToolCalls.length).toBe(3);

    // Verify warning logs were emitted
    const warnLogs = logger.entries.filter(
      (e) => e.message === "DenCompletionPoster: MCP call failed",
    );
    expect(warnLogs.length).toBe(3);

    // Verify error log after exhaust
    const errorLogs = logger.entries.filter(
      (e) => e.message === "DenCompletionPoster: all retries exhausted",
    );
    expect(errorLogs.length).toBe(1);
  });

  it("succeeds on retry if Den recovers", async () => {
    const networkError = new Error("ECONNREFUSED");
    const { mcpClient, callToolCalls } = makeStubMcpClient(
      [makeOkResult("Packet posted on retry")],
      [networkError],
    );

    const poster = createDenCompletionPoster({
      mcpClient,
      projectId: "pi-crew",
      requestedBy: "test-agent",
    });

    const packet = makeValidPacket();
    const result = await poster(packet);

    expect(result.accepted).toBe(true);
    // First call threw, second succeeded
    expect(callToolCalls.length).toBe(2);
  });

  it("includes blocker details in summary for blocked packets", async () => {
    const { mcpClient, callToolCalls } = makeStubMcpClient([makeOkResult()]);
    const poster = createDenCompletionPoster({
      mcpClient,
      projectId: "pi-crew",
      requestedBy: "test-agent",
    });

    const packet = makeValidPacket({
      status: "blocked",
      blocker: {
        reason: "Waiting for dependency",
        requires: "dependency",
        details: "pi-mcp package not released",
      },
    });

    const result = await poster(packet);
    expect(result.accepted).toBe(true);

    const params = callToolCalls[0]?.params;
    if (params) {
      const summary = params.summary as string;
      expect(summary).toContain("Blocker");
      expect(summary).toContain("Waiting for dependency");
    }
  });

  it("handles empty artifacts gracefully", async () => {
    const { mcpClient, callToolCalls } = makeStubMcpClient([makeOkResult()]);
    const poster = createDenCompletionPoster({
      mcpClient,
      projectId: "pi-crew",
      requestedBy: "test-agent",
    });

    const packet = makeValidPacket({
      status: "failed",
      artifacts: [],
      filesTouched: [],
      toolsUsed: [],
    });

    const result = await poster(packet);
    expect(result.accepted).toBe(true);

    const params = callToolCalls[0]?.params;
    if (params) {
      expect(params.status).toBe("failed");
    }
  });
});
