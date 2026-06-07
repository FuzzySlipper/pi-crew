/**
 * PacketAuditor workflow — deterministic Den-backed audit path.
 *
 * This is the machine-checkable companion to PacketAuditorRoleAssembly.
 * The role assembly tells a supervised Agent which Den packet to fetch;
 * this workflow defines the required success and failure semantics with
 * injectable Den readers and the #2061 CompletionPoster seam.
 *
 * @module pi-service/workers/packet-auditor-workflow
 */

import type {
  CompletionPacket,
  CompletionPostResult,
  Result,
} from "@pi-crew/core";
import type { CompletionPoster } from "@pi-crew/tools";
import type { WorkerBinding } from "../sessions/types.js";
import { PacketAuditor } from "./packet-auditor.js";
import type { AuditResult } from "./packet-auditor.js";
import type { TargetPacketRef } from "./worker-role-assembly.js";

/** Failure code for fetching a target completion packet from Den. */
export type PacketAuditFetchFailureCode =
  | "den_unavailable"
  | "missing_packet"
  | "malformed_packet";

/** Structured, machine-checkable Den packet fetch failure. */
export interface PacketAuditFetchFailure {
  /** Canonical failure category. */
  readonly code: PacketAuditFetchFailureCode;
  /** Safe human-readable summary. */
  readonly message: string;
  /** Whether retrying later may succeed. */
  readonly retryable: boolean;
}

/** Read-only Den packet lookup for a target worker completion. */
export interface PacketCompletionReader {
  /** Fetch the latest tracked completion packet for the supplied Den run reference. */
  getLatestWorkerCompletion(
    ref: TargetPacketRef,
  ): Promise<Result<CompletionPacket, PacketAuditFetchFailure>>;
}

/** Input for one packet-auditor supervised workflow pass. */
export interface PacketAuditWorkflowInput {
  /** Auditor assignment/run/task binding, not the target packet binding. */
  readonly auditorBinding: WorkerBinding;
  /** Target completion packet reference to audit. */
  readonly targetPacketRef: TargetPacketRef;
  /** Den reader used to fetch the target packet. */
  readonly reader: PacketCompletionReader;
  /** CompletionPoster from #2061 used for structured Den completion. */
  readonly poster: CompletionPoster;
  /** Optional auditor implementation override for tests. */
  readonly auditor?: PacketAuditor;
  /** Clock injection for deterministic tests. */
  readonly now?: () => string;
}

/** Result of a packet-auditor workflow pass. */
export interface PacketAuditWorkflowResult {
  /** Packet posted through CompletionPoster. */
  readonly completionPacket: CompletionPacket;
  /** Den post result returned by CompletionPoster. */
  readonly postResult: CompletionPostResult;
  /** Audit result when the target packet was fetched and parsed. */
  readonly auditResult?: AuditResult;
  /** Fetch failure when the target packet could not be audited. */
  readonly fetchFailure?: PacketAuditFetchFailure;
}

/**
 * Run one Den-backed packet audit and post a structured completion.
 *
 * Success path:
 * 1. Fetch target completion packet from Den using the supplied run ref.
 * 2. Validate required fields with PacketAuditor.auditPacket().
 * 3. Post an audit_report completion packet through CompletionPoster.
 *
 * Failure path:
 * - Missing/malformed packets and Den availability failures produce a
 *   structured blocked completion with machine-checkable blocker data.
 */
export async function runPacketAuditWorkflow(
  input: PacketAuditWorkflowInput,
): Promise<PacketAuditWorkflowResult> {
  const startedAt = Date.now();
  const fetched = await input.reader.getLatestWorkerCompletion(
    input.targetPacketRef,
  );

  if (!fetched.ok) {
    const completionPacket = buildFetchFailurePacket(
      input,
      fetched.error,
      startedAt,
    );
    const postResult = await input.poster(completionPacket);
    return {
      completionPacket,
      postResult,
      fetchFailure: fetched.error,
    };
  }

  const auditor = input.auditor ?? new PacketAuditor();
  const auditResult = auditor.auditPacket(fetched.value);
  const completionPacket = buildAuditCompletionPacket(
    input,
    auditResult,
    startedAt,
  );
  const postResult = await input.poster(completionPacket);

  return {
    completionPacket,
    postResult,
    auditResult,
  };
}

function buildAuditCompletionPacket(
  input: PacketAuditWorkflowInput,
  auditResult: AuditResult,
  startedAt: number,
): CompletionPacket {
  const errorCount = auditResult.findings.filter(
    (finding) => finding.severity === "error",
  ).length;

  return {
    assignmentId: input.auditorBinding.assignmentId,
    runId: input.auditorBinding.runId,
    taskId: input.auditorBinding.taskId,
    status: "completed",
    artifacts: [
      {
        type: "audit_report",
        ref: `den-worker-run/${input.targetPacketRef.runId}`,
        summary: errorCount === 0
          ? `Packet ${input.targetPacketRef.runId} passed audit`
          : `Packet ${input.targetPacketRef.runId} has ${String(errorCount)} error(s)`,
      },
      {
        type: "audit_context",
        ref: `session/${input.auditorBinding.projectId}/${input.auditorBinding.runId}`,
        summary: `session=${input.auditorBinding.assignmentId}; profile/session supplied by WorkerRoleInput`,
      },
    ],
    filesTouched: [],
    toolsUsed: [
      "den_get_latest_worker_completion",
      "packet_auditor.audit_packet",
      "post_structured_completion",
    ],
    tokensConsumed: 0,
    durationMs: Date.now() - startedAt,
    turnCount: 1,
    role: input.auditorBinding.role,
    completedAt: timestamp(input),
  };
}

function buildFetchFailurePacket(
  input: PacketAuditWorkflowInput,
  failure: PacketAuditFetchFailure,
  startedAt: number,
): CompletionPacket {
  return {
    assignmentId: input.auditorBinding.assignmentId,
    runId: input.auditorBinding.runId,
    taskId: input.auditorBinding.taskId,
    status: "blocked",
    artifacts: [
      {
        type: "audit_fetch_failure",
        ref: `den-worker-run/${input.targetPacketRef.runId}`,
        summary: `${failure.code}: ${failure.message}`,
      },
    ],
    filesTouched: [],
    toolsUsed: [
      "den_get_latest_worker_completion",
      "post_structured_completion",
    ],
    tokensConsumed: 0,
    durationMs: Date.now() - startedAt,
    turnCount: 1,
    blocker: {
      reason: failure.code,
      requires: failure.retryable ? "dependency" : "human",
      details: failure.message,
    },
    role: input.auditorBinding.role,
    completedAt: timestamp(input),
  };
}

function timestamp(input: PacketAuditWorkflowInput): string {
  return input.now?.() ?? new Date().toISOString();
}
