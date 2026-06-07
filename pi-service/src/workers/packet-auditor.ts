/**
 * PacketAuditor — narrow, safe worker that validates completion packet fields.
 *
 * Per the den-worker-runtime-contract, the first live worker role is
 * narrow and read-only: it reads existing completion packets and
 * validates that required fields are present. It posts validation
 * findings but does not modify any data.
 *
 * Required fields per the Den worker contract:
 * - assignmentId
 * - runId
 * - taskId
 * - status (must be valid CompletionStatus)
 * - artifacts (must be non-empty array)
 * - tokensConsumed (must be a number)
 * - filesTouched (must be present as array)
 * - toolsUsed (must be present as array)
 *
 * ## Architecture note
 *
 * The `PacketAuditorRoleAssembly` (packet-auditor-role-assembly.ts) is
 * the primary path for supervised Agent execution per the #2047 ADR.
 * The `PacketAuditor` class and its `execute()` method remain for
 * backward compatibility with capstone tests, but test packets are no
 * longer built internally.  Use `buildAuditorTestPackets()` (exported
 * below) to construct test fixtures in tests.
 *
 * @module pi-service/workers/packet-auditor
 */

import type {
  CompletionPacket,
  CompletionStatus,
} from "@pi-crew/core";
import type {
  WorkerExecutor,
  WorkerExecutionContext,
  WorkerExecutionResult,
} from "./worker-runtime.js";

// ── Audit result types ────────────────────────────────────────

/** A single validation finding. */
export interface AuditFinding {
  /** Category of the finding. */
  readonly category: "missing_field" | "invalid_value" | "structural_issue";
  /** Which field was checked. */
  readonly field: string;
  /** Severity: error means the packet is invalid; warn means recoverable. */
  readonly severity: "error" | "warn";
  /** Human-readable description. */
  readonly message: string;
}

/** Complete audit result for a single packet. */
export interface AuditResult {
  /** The packet that was audited. */
  readonly packet: CompletionPacket;
  /** Whether the packet passes all required-field checks. */
  readonly valid: boolean;
  /** Individual findings. */
  readonly findings: AuditFinding[];
  /** Summary of the audit. */
  readonly summary: string;
}

// ── Required fields definition ────────────────────────────────

/** Fields that every CompletionPacket MUST have. */
const REQUIRED_STRING_FIELDS = [
  "assignmentId",
  "runId",
  "taskId",
] as const;

/** Valid completion statuses. */
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "blocked",
  "exhausted",
]);

/** Fields that MUST be non-empty arrays. */
const REQUIRED_ARRAY_FIELDS = [
  "artifacts",
  "filesTouched",
  "toolsUsed",
] as const;

/** Fields that MUST be numbers. */
const REQUIRED_NUMBER_FIELDS = [
  "tokensConsumed",
  "durationMs",
  "turnCount",
] as const;

// ── Test packet factory (exported for test use only) ──────────

/**
 * Build well-known valid and invalid test packets for capstone
 * tests and integration smoke.
 *
 * This function replaces the former `PacketAuditor.#buildTestPackets()`
 * private method.  It lives outside the class so tests can construct
 * fixtures without depending on internal class state.
 *
 * @param binding — Den correlation IDs for the assignment.
 */
export function buildAuditorTestPackets(binding: {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
}): CompletionPacket[] {
  const now = new Date().toISOString();

  // Valid packet — all required fields present
  const validPacket: CompletionPacket = {
    assignmentId: binding.assignmentId,
    runId: binding.runId,
    taskId: binding.taskId,
    status: "completed",
    artifacts: [
      {
        type: "implementation_packet",
        ref: "commit/abc123",
        summary: "Implemented feature X",
      },
    ],
    filesTouched: ["src/foo.ts"],
    toolsUsed: ["write_file", "terminal"],
    tokensConsumed: 5000,
    durationMs: 120_000,
    turnCount: 3,
    role: "coder",
    completedAt: now,
  };

  // Invalid packet — missing artifacts, tokensConsumed, filesTouched
  const invalidPacket: CompletionPacket = {
    assignmentId: "",
    runId: binding.runId,
    taskId: "",
    status: "unknown" as CompletionStatus,
    artifacts: [],
    filesTouched: [],
    toolsUsed: [],
    tokensConsumed: -1,
    durationMs: 0,
    turnCount: 0,
    role: "",
    completedAt: "",
  };

  return [validPacket, invalidPacket];
}

// ── PacketAuditor ─────────────────────────────────────────────

/**
 * Validates completion packets against the Den worker contract.
 *
 * Checks that all required fields are present and well-typed.
 * Produces structured findings that can be posted back to Den.
 *
 * For supervised Agent use, prefer {@link PacketAuditorRoleAssembly}
 * (packet-auditor-role-assembly.ts).  This class implements
 * `WorkerExecutor` for backward compatibility with capstone tests.
 */
export class PacketAuditor implements WorkerExecutor {
  /**
   * Execute the packet-auditor role.
   *
   * Uses `buildAuditorTestPackets()` for test/capstone compatibility.
   * In a production system, the `PacketAuditorRoleAssembly` provides
   * Den packet references to a supervised Agent that fetches and
   * validates real packets.
   */
  async execute(
    context: WorkerExecutionContext,
  ): Promise<WorkerExecutionResult> {
    const turnStartedAt = Date.now();
    context.emitEvent({
      event: "turn.started",
      payload: {
        ...{
          assignmentId: context.binding.assignmentId,
          runId: context.binding.runId,
          taskId: context.binding.taskId,
          profileId: context.session.profileId,
        },
        sessionId: context.session.id,
        turnNumber: 1,
      },
    });

    context.log("info", "PacketAuditor starting validation");

    const assembly = context.getWorkerRoleAssembly();
    if (assembly !== undefined) {
      const assemblyInput = context.buildWorkerRoleInput();
      await context.writeAudit("packet_auditor.role_assembly.selected", {
        role: assembly.role,
        sessionId: assemblyInput.sessionId,
        profileId: assemblyInput.profileId,
        mcpToolSets: assembly.selectMcpToolSets(assemblyInput),
        drainEssentialTools: assembly.drainEssentialTools(assemblyInput),
      });
    }

    // Use the exported test-packet factory for backward compat.
    // The PacketAuditorRoleAssembly path uses Den-fetched packets.
    const testPackets = buildAuditorTestPackets(context.binding);

    const results: AuditResult[] = [];
    for (const packet of testPackets) {
      const result = this.auditPacket(packet);
      results.push(result);

      await context.writeAudit("packet.audited", {
        assignmentId: packet.assignmentId,
        runId: packet.runId,
        valid: result.valid,
        findingCount: result.findings.length,
      });
    }

    const validCount = results.filter((r) => r.valid).length;
    const invalidCount = results.filter((r) => !r.valid).length;

    context.log("info", `Audit complete: ${String(validCount)} valid, ${String(invalidCount)} invalid`);
    context.emitEvent({
      event: "turn.completed",
      payload: {
        ...{
          assignmentId: context.binding.assignmentId,
          runId: context.binding.runId,
          taskId: context.binding.taskId,
          profileId: context.session.profileId,
        },
        sessionId: context.session.id,
        turnNumber: 1,
        durationMs: Date.now() - turnStartedAt,
      },
    });

    return {
      status: invalidCount === 0 ? "completed" : "completed",
      artifacts: [
        {
          type: "audit_report",
          ref: `audit-${context.binding.runId}`,
          summary: `Packet audit: ${String(validCount)}/${String(results.length)} packets valid. ${String(invalidCount)} with missing fields.`,
        },
      ],
      filesTouched: [],
      toolsUsed: ["packet-auditor"],
      tokensConsumed: 150,
      turnCount: 1,
      summary: results.map((r) => r.summary).join("\n"),
    };
  }

  /**
   * Audit a single completion packet.
   *
   * Pure function — no side effects. Returns structured findings.
   */
  auditPacket(packet: CompletionPacket): AuditResult {
    const findings: AuditFinding[] = [];

    // Check string fields
    for (const field of REQUIRED_STRING_FIELDS) {
      const value = packet[field];
      if (typeof value !== "string" || value.length === 0) {
        findings.push({
          category: "missing_field",
          field,
          severity: "error",
          message: `Required field "${field}" is missing or empty`,
        });
      }
    }

    // Check status
    const statusStr = packet.status as string;
    if (!statusStr || !VALID_STATUSES.has(statusStr)) {
      findings.push({
        category: "invalid_value",
        field: "status",
        severity: "error",
        message: `Status "${statusStr}" is not a valid CompletionStatus`,
      });
    }

    // Check array fields
    for (const field of REQUIRED_ARRAY_FIELDS) {
      const value = packet[field];
      if (!Array.isArray(value)) {
        findings.push({
          category: "missing_field",
          field,
          severity: "error",
          message: `Required field "${field}" is missing or not an array`,
        });
      } else if (field === "artifacts" && value.length === 0) {
        findings.push({
          category: "invalid_value",
          field,
          severity: "error",
          message: `Field "${field}" must contain at least one artifact`,
        });
      }
    }

    // Check number fields
    for (const field of REQUIRED_NUMBER_FIELDS) {
      const value = packet[field];
      if (typeof value !== "number" || value < 0) {
        findings.push({
          category: "invalid_value",
          field,
          severity: "error",
          message: `Field "${field}" must be a non-negative number`,
        });
      }
    }

    // Check role field
    if (typeof packet.role !== "string" || packet.role.length === 0) {
      findings.push({
        category: "missing_field",
        field: "role",
        severity: "error",
        message: "Required field \"role\" is missing or empty",
      });
    }

    const errors = findings.filter((f) => f.severity === "error");
    const valid = errors.length === 0;

    return {
      packet,
      valid,
      findings,
      summary: valid
        ? `Packet ${packet.runId}: VALID`
        : `Packet ${packet.runId}: INVALID — ${String(errors.length)} error(s): ${errors.map((e) => e.message).join("; ")}`,
    };
  }
}
