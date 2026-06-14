/**
 * Tests for AgentWorkBreadcrumbRepository (in-memory implementation).
 *
 * Covers:
 * - Append and retrieve
 * - Update by ID
 * - Update by correlation (coalescing)
 * - Query by correlation filter
 * - Delete
 * - Family-scoped queries
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createParentBreadcrumb,
  createDelegationBreadcrumb,
  createToolBreadcrumb,
  type ParentLifecycleBreadcrumb,
  type DelegationLifecycleBreadcrumb,
  type ToolEventBreadcrumb,
} from "./agent-work-breadcrumbs.js";
import { InMemoryBreadcrumbRepository } from "./test-helpers/in-memory-breadcrumb-repository.js";

describe("InMemoryBreadcrumbRepository", () => {
  let repo: InMemoryBreadcrumbRepository;

  beforeEach(() => {
    repo = new InMemoryBreadcrumbRepository();
  });

  // ── Append ──────────────────────────────────────────────────────

  describe("append", () => {
    it("stores and retrieves a parent breadcrumb", async () => {
      const bc = createParentBreadcrumb({
        projectId: "pi-crew",
        channelId: "ch-642",
        eventType: "pi_crew.parent.runtime_received",
        state: "started",
        severity: "info",
        summary: "Agent received request",
        evidence: {},
        metadata: {},
        eventFamily: "parent",
        agentIdentity: "pi-orchestrator",
        profileId: "orchestrator-v1",
        sessionId: "sess-001",
      });

      const saved = await repo.append(bc);
      expect(saved.id).toBe(bc.id);
      expect(repo.size).toBe(1);

      const retrieved = await repo.getById(bc.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(bc.id);
    });

    it("stores delegation and tool breadcrumbs", async () => {
      const del = createDelegationBreadcrumb({
        projectId: "pi-crew",
        channelId: "ch-642",
        eventType: "pi_crew.delegation.spawned",
        state: "started",
        severity: "info",
        summary: "Child spawned",
        evidence: {},
        metadata: {},
        eventFamily: "delegation",
        parentAgentIdentity: "prime-coder",
        parentSessionId: "sess-parent",
        rootSessionId: "sess-root",
        childSessionId: "sess-child-1",
        profileId: "reviewer-worker",
        policyId: "pol-123",
        depth: 1,
      });

      const tool = createToolBreadcrumb({
        projectId: "pi-crew",
        channelId: "ch-642",
        eventType: "pi_crew.delegation.tool_called",
        state: "started",
        severity: "debug",
        summary: "Tool called",
        evidence: {},
        metadata: {},
        eventFamily: "tool",
        toolName: "read_file",
        toolCallId: "tc-001",
        phase: "called",
        isError: false,
        resultClass: "ok",
        ownerSessionId: "sess-child-1",
      });

      await repo.append(del);
      await repo.append(tool);
      expect(repo.size).toBe(2);
    });
  });

  // ── Update by ID ────────────────────────────────────────────────

  describe("updateById", () => {
    it("updates state and summary of an existing breadcrumb", async () => {
      const bc = createParentBreadcrumb({
        projectId: "pi-crew",
        channelId: "ch-642",
        eventType: "pi_crew.parent.runtime_received",
        state: "started",
        severity: "info",
        summary: "Agent received request",
        evidence: {},
        metadata: {},
        eventFamily: "parent",
        agentIdentity: "pi-orchestrator",
        profileId: "orchestrator-v1",
        sessionId: "sess-001",
      });

      await repo.append(bc);
      const updated = await repo.updateById(bc.id, {
        state: "completed",
        summary: "Agent completed successfully",
        finalMessageId: 42,
      });

      expect(updated).not.toBeNull();
      expect(updated!.state).toBe("completed");
      expect(updated!.summary).toBe("Agent completed successfully");
    });

    it("returns null for non-existent ID", async () => {
      const result = await repo.updateById("non-existent", {
        state: "completed",
      });
      expect(result).toBeNull();
    });
  });

  // ── Update by correlation (coalescing) ──────────────────────────

  describe("updateByCorrelation", () => {
    it("updates a tool row by toolCallId (coalescing called→completed)", async () => {
      const toolCalled = createToolBreadcrumb({
        projectId: "pi-crew",
        channelId: "ch-642",
        eventType: "pi_crew.delegation.tool_called",
        state: "started",
        severity: "debug",
        summary: "Tool read_file called",
        evidence: {},
        metadata: {},
        eventFamily: "tool",
        toolName: "read_file",
        toolCallId: "tc-coalesce-001",
        phase: "called",
        isError: false,
        resultClass: "ok",
        ownerSessionId: "sess-child-1",
      });

      await repo.append(toolCalled);

      // Simulate tool_completed arriving — update the existing row
      const updated = await repo.updateByCorrelation(
        { toolCallId: "tc-coalesce-001", eventFamily: "tool" },
        {
          state: "completed",
          phase: "completed",
          durationMs: 42,
          resultClass: "ok",
          summary: "Tool read_file completed (42ms)",
        },
      );

      expect(updated).not.toBeNull();
      expect(updated!.state).toBe("completed");

      // Verify the stored row was updated, not duplicated
      expect(repo.size).toBe(1);
      const stored = await repo.getById(toolCalled.id);
      expect(stored).not.toBeNull();
    });

    it("returns null when no breadcrumb matches the correlation", async () => {
      const result = await repo.updateByCorrelation(
        { toolCallId: "tc-nonexistent" },
        { state: "completed" },
      );
      expect(result).toBeNull();
    });

    it("updates delegation row by childSessionId", async () => {
      const spawned = createDelegationBreadcrumb({
        projectId: "pi-crew",
        channelId: "ch-642",
        eventType: "pi_crew.delegation.spawned",
        state: "started",
        severity: "info",
        summary: "Child spawned",
        evidence: {},
        metadata: {},
        eventFamily: "delegation",
        parentAgentIdentity: "prime-coder",
        parentSessionId: "sess-parent",
        rootSessionId: "sess-root",
        childSessionId: "sess-child-update",
        profileId: "coder-v1",
        policyId: "pol-123",
        depth: 1,
      });

      await repo.append(spawned);

      const updated = await repo.updateByCorrelation(
        { childSessionId: "sess-child-update" },
        {
          state: "completed",
          outcome: "success",
          durationMs: 3000,
          turnsUsed: 2,
          tokensConsumed: 8000,
        },
      );

      expect(updated).not.toBeNull();
      expect(updated!.state).toBe("completed");
    });
  });

  // ── Query by correlation ────────────────────────────────────────

  describe("queryByCorrelation", () => {
    beforeEach(async () => {
      // Seed: parent, delegation, and tool events
      await repo.append(
        createParentBreadcrumb({
          projectId: "pi-crew",
          channelId: "ch-642",
          eventType: "pi_crew.parent.runtime_received",
          state: "started",
          severity: "info",
          summary: "Parent received",
          evidence: {},
          metadata: {},
          eventFamily: "parent",
          agentIdentity: "pi-orchestrator",
          profileId: "orchestrator-v1",
          sessionId: "sess-parent-q",
        }),
      );

      await repo.append(
        createDelegationBreadcrumb({
          projectId: "pi-crew",
          channelId: "ch-642",
          eventType: "pi_crew.delegation.spawned",
          state: "started",
          severity: "info",
          summary: "Child spawned",
          evidence: {},
          metadata: {},
          eventFamily: "delegation",
          parentAgentIdentity: "pi-orchestrator",
          parentSessionId: "sess-parent-q",
          rootSessionId: "sess-parent-q",
          childSessionId: "sess-child-q1",
          profileId: "coder-v1",
          policyId: "pol-q",
          depth: 1,
        }),
      );

      await repo.append(
        createToolBreadcrumb({
          projectId: "pi-crew",
          channelId: "ch-642",
          eventType: "pi_crew.delegation.tool_called",
          state: "started",
          severity: "debug",
          summary: "Tool called",
          evidence: {},
          metadata: {},
          eventFamily: "tool",
          toolName: "read_file",
          toolCallId: "tc-q1",
          phase: "called",
          isError: false,
          resultClass: "ok",
          ownerSessionId: "sess-child-q1",
        }),
      );
    });

    it("filters by event family", async () => {
      const parentRows = await repo.queryByCorrelation({
        eventFamily: "parent",
      });
      expect(parentRows).toHaveLength(1);
      expect(parentRows[0]!.eventFamily).toBe("parent");

      const delegationRows = await repo.queryByCorrelation({
        eventFamily: "delegation",
      });
      expect(delegationRows).toHaveLength(1);

      const toolRows = await repo.queryByCorrelation({ eventFamily: "tool" });
      expect(toolRows).toHaveLength(1);
    });

    it("filters by projectId", async () => {
      const results = await repo.queryByCorrelation({ projectId: "pi-crew" });
      expect(results).toHaveLength(3);

      const empty = await repo.queryByCorrelation({
        projectId: "other-project",
      });
      expect(empty).toHaveLength(0);
    });

    it("filters by channelId", async () => {
      const results = await repo.queryByCorrelation({ channelId: "ch-642" });
      expect(results).toHaveLength(3);
    });

    it("filters by childSessionId", async () => {
      const results = await repo.queryByCorrelation({
        childSessionId: "sess-child-q1",
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.eventFamily).toBe("delegation");
    });

    it("filters by toolCallId", async () => {
      const results = await repo.queryByCorrelation({ toolCallId: "tc-q1" });
      expect(results).toHaveLength(1);
      expect(results[0]!.eventFamily).toBe("tool");
    });

    it("combines multiple filter fields (AND)", async () => {
      const results = await repo.queryByCorrelation({
        eventFamily: "tool",
        projectId: "pi-crew",
      });
      expect(results).toHaveLength(1);

      const empty = await repo.queryByCorrelation({
        eventFamily: "tool",
        projectId: "other",
      });
      expect(empty).toHaveLength(0);
    });

    it("returns empty array when no matches", async () => {
      const results = await repo.queryByCorrelation({
        childSessionId: "nonexistent",
      });
      expect(results).toHaveLength(0);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────

  describe("deleteById", () => {
    it("removes a breadcrumb by ID", async () => {
      const bc = createParentBreadcrumb({
        projectId: "pi-crew",
        channelId: "ch-642",
        eventType: "pi_crew.parent.runtime_received",
        state: "started",
        severity: "info",
        summary: "To be deleted",
        evidence: {},
        metadata: {},
        eventFamily: "parent",
        agentIdentity: "pi-orchestrator",
        profileId: "orchestrator-v1",
        sessionId: "sess-del",
      });

      await repo.append(bc);
      expect(repo.size).toBe(1);

      await repo.deleteById(bc.id);
      expect(repo.size).toBe(0);

      const retrieved = await repo.getById(bc.id);
      expect(retrieved).toBeNull();
    });
  });

  // ── Test helpers ────────────────────────────────────────────────

  describe("test helpers", () => {
    it("clear removes all breadcrumbs", async () => {
      await repo.append(
        createParentBreadcrumb({
          projectId: "pi-crew",
          channelId: "ch-642",
          eventType: "pi_crew.parent.runtime_received",
          state: "started",
          severity: "info",
          summary: "One",
          evidence: {},
          metadata: {},
          eventFamily: "parent",
          agentIdentity: "pi-orchestrator",
          profileId: "orchestrator-v1",
          sessionId: "sess-clear-1",
        }),
      );
      await repo.append(
        createParentBreadcrumb({
          projectId: "pi-crew",
          channelId: "ch-642",
          eventType: "pi_crew.parent.completed",
          state: "completed",
          severity: "info",
          summary: "Two",
          evidence: {},
          metadata: {},
          eventFamily: "parent",
          agentIdentity: "pi-orchestrator",
          profileId: "orchestrator-v1",
          sessionId: "sess-clear-2",
        }),
      );

      expect(repo.size).toBe(2);
      repo.clear();
      expect(repo.size).toBe(0);
    });

    it("getAll returns all stored breadcrumbs", async () => {
      await repo.append(
        createParentBreadcrumb({
          projectId: "pi-crew",
          channelId: "ch-642",
          eventType: "pi_crew.parent.runtime_received",
          state: "started",
          severity: "info",
          summary: "One",
          evidence: {},
          metadata: {},
          eventFamily: "parent",
          agentIdentity: "pi-orchestrator",
          profileId: "orchestrator-v1",
          sessionId: "sess-all-1",
        }),
      );

      const all = repo.getAll();
      expect(all).toHaveLength(1);
    });
  });
});
