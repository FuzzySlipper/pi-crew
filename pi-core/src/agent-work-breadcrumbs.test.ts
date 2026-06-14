/**
 * Tests for agent-work breadcrumb DTOs.
 *
 * Covers DTO construction, required fields, raw-transcript rejection,
 * summary length validation, task excerpt truncation, grouping keys.
 */
import { describe, it, expect } from "vitest";
import {
  createParentBreadcrumb,
  createDelegationBreadcrumb,
  createToolBreadcrumb,
  findForbiddenRawFields,
  truncateText,
  parentGroupingKey,
  delegationGroupingKey,
  BreadcrumbValidationError,
  FORBIDDEN_RAW_FIELDS,
  MAX_TASK_EXCERPT_LENGTH,
  MAX_SUMMARY_LENGTH,
} from "./agent-work-breadcrumbs.js";

// ── Shared inputs ───────────────────────────────────────────────

const baseParent = {
  projectId: "pi-crew",
  channelId: "ch-642",
  evidence: {},
  metadata: {},
  eventFamily: "parent" as const,
  agentIdentity: "pi-orchestrator",
  profileId: "orchestrator-v1",
  sessionId: "sess-abc-123",
};

const baseDelegation = {
  projectId: "pi-crew",
  channelId: "ch-642",
  evidence: {},
  metadata: {},
  eventFamily: "delegation" as const,
  parentAgentIdentity: "prime-coder",
  parentSessionId: "sess-parent",
  rootSessionId: "sess-root",
  childSessionId: "sess-child-1",
  profileId: "reviewer-worker",
  policyId: "pol-123",
  depth: 1,
};

// ── Parent lifecycle DTO ────────────────────────────────────────

describe("createParentBreadcrumb", () => {
  it("constructs a valid parent lifecycle breadcrumb", () => {
    const bc = createParentBreadcrumb({
      ...baseParent,
      eventType: "pi_crew.parent.runtime_received",
      state: "started",
      severity: "info",
      summary: "Agent pi-orchestrator received runtime request",
    });
    expect(bc.id).toBeDefined();
    expect(bc.source).toBe("pi-crew");
    expect(bc.createdAt).toBeDefined();
    expect(bc.eventFamily).toBe("parent");
    expect(bc.agentIdentity).toBe("pi-orchestrator");
  });

  it("uses provided id and createdAt", () => {
    const bc = createParentBreadcrumb({
      ...baseParent,
      id: "custom-id",
      createdAt: "2026-06-13T12:00:00Z",
      eventType: "pi_crew.parent.completed",
      state: "completed",
      severity: "info",
      summary: "Agent completed",
      finalMessageId: 42,
    });
    expect(bc.id).toBe("custom-id");
    expect(bc.createdAt).toBe("2026-06-13T12:00:00Z");
    expect(bc.finalMessageId).toBe(42);
  });

  it("rejects evidence containing raw transcript fields", () => {
    expect(() =>
      createParentBreadcrumb({
        ...baseParent,
        eventType: "pi_crew.parent.completed",
        state: "completed",
        severity: "info",
        summary: "Agent completed",
        evidence: { rawTranscript: "full conversation here" },
      }),
    ).toThrow(BreadcrumbValidationError);
  });

  it("rejects metadata containing raw transcript fields", () => {
    expect(() =>
      createParentBreadcrumb({
        ...baseParent,
        eventType: "pi_crew.parent.completed",
        state: "completed",
        severity: "info",
        summary: "Agent completed",
        metadata: { fullResponse: "the entire LLM response" },
      }),
    ).toThrow(BreadcrumbValidationError);
  });

  it("rejects summary exceeding max length", () => {
    expect(() =>
      createParentBreadcrumb({
        ...baseParent,
        eventType: "pi_crew.parent.completed",
        state: "completed",
        severity: "info",
        summary: "x".repeat(MAX_SUMMARY_LENGTH + 1),
      }),
    ).toThrow(BreadcrumbValidationError);
  });

  it("carries optional correlation fields", () => {
    const bc = createParentBreadcrumb({
      ...baseParent,
      eventType: "pi_crew.parent.request_claimed",
      state: "interim",
      severity: "info",
      summary: "Request claimed",
      deliveryRequestId: "dreq-001",
      sourceMessageId: 55,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      turnId: 3,
    });
    expect(bc.deliveryRequestId).toBe("dreq-001");
    expect(bc.sourceMessageId).toBe(55);
    expect(bc.provider).toBe("anthropic");
    expect(bc.turnId).toBe(3);
  });
});

// ── Delegation lifecycle DTO ────────────────────────────────────

describe("createDelegationBreadcrumb", () => {
  it("constructs a valid delegation lifecycle breadcrumb", () => {
    const bc = createDelegationBreadcrumb({
      ...baseDelegation,
      eventType: "pi_crew.delegation.spawned",
      state: "started",
      severity: "info",
      summary: "Delegated child spawned",
      taskExcerpt: "Review the implementation of breadcrumb DTOs",
    });
    expect(bc.eventFamily).toBe("delegation");
    expect(bc.childSessionId).toBe("sess-child-1");
    expect(bc.taskExcerpt).toBe("Review the implementation of breadcrumb DTOs");
  });

  it("truncates task excerpt to max length", () => {
    const bc = createDelegationBreadcrumb({
      ...baseDelegation,
      childSessionId: "sess-child-2",
      eventType: "pi_crew.delegation.spawned",
      state: "started",
      severity: "info",
      summary: "Spawned",
      taskExcerpt: "A".repeat(500),
    });
    expect(bc.taskExcerpt!.length).toBeLessThanOrEqual(MAX_TASK_EXCERPT_LENGTH);
    expect(bc.taskExcerpt!.endsWith("…")).toBe(true);
  });

  it("rejects evidence with raw transcript fields", () => {
    expect(() =>
      createDelegationBreadcrumb({
        ...baseDelegation,
        childSessionId: "sess-child-3",
        eventType: "pi_crew.delegation.completed",
        state: "completed",
        severity: "info",
        summary: "Child completed",
        evidence: { rawOutput: "full child output here" },
      }),
    ).toThrow(BreadcrumbValidationError);
  });

  it("carries completion fields for terminal events", () => {
    const bc = createDelegationBreadcrumb({
      ...baseDelegation,
      childSessionId: "sess-child-4",
      eventType: "pi_crew.delegation.completed",
      state: "completed",
      severity: "info",
      summary: "Child completed successfully",
      evidence: { commitShas: ["abc123"] },
      outcome: "success",
      durationMs: 5000,
      turnsUsed: 3,
      tokensConsumed: 12000,
      evidenceChecked: true,
      artifactCount: 2,
    });
    expect(bc.outcome).toBe("success");
    expect(bc.durationMs).toBe(5000);
    expect(bc.turnsUsed).toBe(3);
    expect(bc.tokensConsumed).toBe(12000);
    expect(bc.artifactCount).toBe(2);
  });

  it("carries batch fields for fan-out", () => {
    const bc = createDelegationBreadcrumb({
      ...baseDelegation,
      childSessionId: "sess-child-batch-0",
      eventType: "pi_crew.delegation.spawned",
      state: "started",
      severity: "info",
      summary: "Fan-out child spawned",
      batchId: "batch-001",
      batchIndex: 0,
    });
    expect(bc.batchId).toBe("batch-001");
    expect(bc.batchIndex).toBe(0);
  });
});

// ── Tool event DTO ──────────────────────────────────────────────

describe("createToolBreadcrumb", () => {
  const baseTool = {
    projectId: "pi-crew",
    channelId: "ch-642",
    evidence: {},
    metadata: {},
    eventFamily: "tool" as const,
    toolName: "read_file",
    toolCallId: "tc-001",
    isError: false,
    resultClass: "ok" as const,
    ownerSessionId: "sess-child-1",
  };

  it("constructs a valid tool event breadcrumb", () => {
    const bc = createToolBreadcrumb({
      ...baseTool,
      eventType: "pi_crew.delegation.tool_called",
      state: "started",
      severity: "debug",
      summary: "Tool read_file called",
      phase: "called",
    });
    expect(bc.eventFamily).toBe("tool");
    expect(bc.toolName).toBe("read_file");
    expect(bc.phase).toBe("called");
  });

  it("carries completion fields", () => {
    const bc = createToolBreadcrumb({
      ...baseTool,
      eventType: "pi_crew.delegation.tool_completed",
      state: "completed",
      severity: "debug",
      summary: "Tool read_file completed (42ms)",
      evidence: { filePaths: ["src/foo.ts"] },
      phase: "completed",
      durationMs: 42,
    });
    expect(bc.durationMs).toBe(42);
    expect(bc.phase).toBe("completed");
  });

  it("rejects evidence with raw transcript fields", () => {
    expect(() =>
      createToolBreadcrumb({
        ...baseTool,
        toolCallId: "tc-002",
        toolName: "terminal",
        eventType: "pi_crew.delegation.tool_completed",
        state: "completed",
        severity: "debug",
        summary: "Tool completed",
        evidence: { rawResult: "full tool output" },
        phase: "completed",
      }),
    ).toThrow(BreadcrumbValidationError);
  });

  it("carries coalescing counters", () => {
    const bc = createToolBreadcrumb({
      ...baseTool,
      toolCallId: "tc-coalesced",
      eventType: "pi_crew.delegation.tool_called",
      state: "interim",
      severity: "debug",
      summary: "Tool calls coalesced",
      phase: "called",
      coalescedToolCallCount: 5,
      coalescedCompletedCount: 3,
    });
    expect(bc.coalescedToolCallCount).toBe(5);
    expect(bc.coalescedCompletedCount).toBe(3);
  });
});

// ── Raw field detection ─────────────────────────────────────────

describe("findForbiddenRawFields", () => {
  it("returns empty array for clean objects", () => {
    expect(findForbiddenRawFields({ messageIds: [1], summary: "ok" })).toEqual([]);
  });

  it("detects all forbidden field names", () => {
    for (const field of FORBIDDEN_RAW_FIELDS) {
      expect(findForbiddenRawFields({ [field]: "data" })).toContain(field);
    }
  });

  it("detects multiple forbidden fields at once", () => {
    const result = findForbiddenRawFields({
      rawTranscript: "data",
      fullPrompt: "data",
      clean: "ok",
    });
    expect(result).toHaveLength(2);
  });
});

// ── Text truncation ─────────────────────────────────────────────

describe("truncateText", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });

  it("truncates and appends ellipsis when over limit", () => {
    const result = truncateText("hello world", 6);
    expect(result).toBe("hello…");
    expect(result.length).toBe(6);
  });

  it("handles exact boundary", () => {
    expect(truncateText("12345", 5)).toBe("12345");
  });
});

// ── Grouping keys ───────────────────────────────────────────────

describe("grouping keys", () => {
  it("computes parent grouping key with deliveryRequestId", () => {
    const bc = createParentBreadcrumb({
      ...baseParent,
      eventType: "pi_crew.parent.runtime_received",
      state: "started",
      severity: "info",
      summary: "Received",
      deliveryRequestId: "dreq-001",
    });
    expect(parentGroupingKey(bc)).toBe("pi-crew-agent:pi-orchestrator:dreq-001");
  });

  it("computes parent grouping key with sessionId fallback", () => {
    const bc = createParentBreadcrumb({
      ...baseParent,
      agentIdentity: "prime-coder",
      sessionId: "sess-xyz",
      eventType: "pi_crew.parent.runtime_received",
      state: "started",
      severity: "info",
      summary: "Received",
    });
    expect(parentGroupingKey(bc)).toBe("pi-crew-agent:prime-coder:sess-xyz");
  });

  it("computes delegation grouping key", () => {
    const bc = createDelegationBreadcrumb({
      ...baseDelegation,
      eventType: "pi_crew.delegation.spawned",
      state: "started",
      severity: "info",
      summary: "Spawned",
    });
    expect(delegationGroupingKey(bc)).toBe("pi-crew-delegation:sess-child-1");
  });
});
