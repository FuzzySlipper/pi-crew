/**
 * Unit tests for PacketAuditor — validates completion packet required fields.
 *
 * @module pi-service/__tests__/workers/packet-auditor
 */

import { describe, it, expect } from "vitest";
import { PacketAuditor } from "../../workers/packet-auditor.js";
import type {
  AuditFinding,
  AuditResult,
} from "../../workers/packet-auditor.js";
import type { CompletionPacket, CompletionStatus } from "@pi-crew/core";

function makePacket(
  overrides?: Partial<CompletionPacket>,
): CompletionPacket {
  const now = new Date().toISOString();
  return {
    assignmentId: "296",
    runId: "piw_1864_test",
    taskId: "1864",
    status: "completed",
    artifacts: [
      { type: "implementation_packet", ref: "abc123", summary: "Test" },
    ],
    filesTouched: ["src/foo.ts"],
    toolsUsed: ["write_file"],
    tokensConsumed: 5000,
    durationMs: 60_000,
    turnCount: 2,
    role: "coder",
    completedAt: now,
    ...overrides,
  };
}

describe("PacketAuditor", () => {
  const auditor = new PacketAuditor();

  // ── Valid packets ─────────────────────────────────────────

  it("accepts a fully valid completion packet", () => {
    const packet = makePacket();
    const result = auditor.auditPacket(packet);

    expect(result.valid).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain("VALID");
  });

  // ── Missing string fields ─────────────────────────────────

  it("flags empty assignmentId", () => {
    const packet = makePacket({ assignmentId: "" });
    const result = auditor.auditPacket(packet);

    expect(result.valid).toBe(false);
    const error = errorFor(result, "assignmentId");
    expect(error).toBeDefined();
    expect(error?.message).toContain("missing or empty");
  });

  it("flags empty runId", () => {
    const packet = makePacket({ runId: "" });
    const result = auditor.auditPacket(packet);

    expect(result.valid).toBe(false);
    expect(errorFor(result, "runId")).toBeDefined();
  });

  it("flags empty taskId", () => {
    const packet = makePacket({ taskId: "" });
    const result = auditor.auditPacket(packet);

    expect(result.valid).toBe(false);
    expect(errorFor(result, "taskId")).toBeDefined();
  });

  // ── Invalid status ────────────────────────────────────────

  it("flags invalid status value", () => {
    const packet = makePacket({ status: "unknown" as CompletionStatus });
    const result = auditor.auditPacket(packet);

    expect(result.valid).toBe(false);
    const error = errorFor(result, "status");
    expect(error).toBeDefined();
    expect(error?.message).toContain("not a valid CompletionStatus");
  });

  it("accepts all valid status values", () => {
    const validStatuses: CompletionStatus[] = [
      "completed",
      "failed",
      "blocked",
      "exhausted",
    ];

    for (const status of validStatuses) {
      const packet = makePacket({ status });
      const result = auditor.auditPacket(packet);
      expect(result.valid).toBe(true);
    }
  });

  // ── Missing/invalid array fields ──────────────────────────

  it("flags missing artifacts array", () => {
    const mod: CompletionPacket = { ...makePacket(), artifacts: [] };
    const result = auditor.auditPacket(mod);

    expect(result.valid).toBe(false);
    const error = errorFor(result, "artifacts");
    expect(error).toBeDefined();
  });

  it("accepts valid filesTouched and toolsUsed", () => {
    const packet = makePacket({
      filesTouched: ["a.ts", "b.ts"],
      toolsUsed: ["terminal", "write_file"],
    });
    const result = auditor.auditPacket(packet);

    expect(result.valid).toBe(true);
  });

  // ── Number fields ─────────────────────────────────────────

  it("flags negative tokensConsumed", () => {
    const packet = makePacket({ tokensConsumed: -10 });
    const result = auditor.auditPacket(packet);

    expect(result.valid).toBe(false);
    const error = errorFor(result, "tokensConsumed");
    expect(error).toBeDefined();
    expect(error?.message).toContain("non-negative number");
  });

  it("accepts zero tokensConsumed", () => {
    const packet = makePacket({ tokensConsumed: 0, artifacts: [{ type: "test", ref: "r", summary: "s" }] });
    const result = auditor.auditPacket(packet);

    expect(result.valid).toBe(true);
  });

  // ── Missing role ──────────────────────────────────────────

  it("flags empty role", () => {
    const packet = makePacket({ role: "" });
    const result = auditor.auditPacket(packet);

    expect(result.valid).toBe(false);
    expect(errorFor(result, "role")).toBeDefined();
  });

  // ── Multiple findings ─────────────────────────────────────

  it("reports all errors for a completely invalid packet", () => {
    const packet = makePacket({
      assignmentId: "",
      runId: "",
      taskId: "",
      status: "invalid" as CompletionStatus,
      artifacts: [],
      tokensConsumed: -1,
      role: "",
    });

    const result = auditor.auditPacket(packet);
    expect(result.valid).toBe(false);

    // Should have at least 6 errors
    const errors = result.findings.filter((f) => f.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(6);
  });

  // ── Summary format ────────────────────────────────────────

  it("summary includes field names for invalid packets", () => {
    const packet = makePacket({ assignmentId: "" });
    const result = auditor.auditPacket(packet);

    expect(result.summary).toContain("INVALID");
    expect(result.summary).toContain("assignmentId");
  });

  it("summary is readable for valid packets", () => {
    const packet = makePacket();
    const result = auditor.auditPacket(packet);

    expect(result.summary).toContain("VALID");
    expect(result.summary).toContain(packet.runId);
  });
});

// ── Helpers ─────────────────────────────────────────────────

function errorFor(
  result: AuditResult,
  field: string,
): AuditFinding | undefined {
  return result.findings.find((f) => f.field === field && f.severity === "error");
}
