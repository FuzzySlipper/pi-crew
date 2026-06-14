/**
 * Worker completion monitor — assesses closeout status from worker evidence.
 *
 * DESIGN: This is a pure assessment utility that takes raw worker state and
 * derives a structured closeout decision. It does NOT call Den MCP tools
 * directly — the full agent or executor is responsible for
 * gathering the raw data and passing it in.
 *
 * Rationale: Separating assessment from data gathering makes this testable
 * without mocking Den MCP, and allows reuse from different contexts
 * (full agent, worker executor, admin CLI).
 *
 * @module pi-service/workers/worker-completion-monitor
 */

import type { EventBus, Logger } from "@pi-crew/core";

// ── Types ──────────────────────────────────────────────────────

/** Raw worker state gathered from Den MCP or local sources. */
export interface WorkerCompletionAssessInput {
  readonly assignmentId: number;
  readonly runId: string;
  readonly taskId: number;
  readonly rawStatus: string;
  readonly completionPacket?: Record<string, unknown>;
  readonly reviewWorkflow?: {
    readonly roundCount: number;
    readonly unresolvedFindings: number;
    readonly resolvedFindings: number;
  };
  readonly workerRole: string;
}

/** Closeout status derived from worker evidence. */
export type CloseoutStatus =
  | "in_progress"
  | "ready_for_review"
  | "review_open"
  | "done"
  | "blocked"
  | "malformed";

/** Structured closeout assessment result. */
export interface WorkerCompletionStatus {
  readonly assignmentId: number;
  readonly runId: string;
  readonly taskId: number;
  readonly status: string;
  readonly completionPacket?: {
    readonly status: string;
    readonly branch?: string | null;
    readonly headCommit?: string | null;
    readonly testsRun?: boolean | null;
    readonly artifactKind?: string;
    readonly failureCategory?: string;
    readonly recoveryGuidance?: string;
  };
  readonly reviewState?: {
    readonly roundCount: number;
    readonly unresolvedFindings: number;
    readonly resolvedFindings: number;
  };
  readonly readyForReview: boolean;
  readonly closeoutStatus: CloseoutStatus;
  readonly nextAction: string;
  readonly evidenceHandles: readonly string[];
}

// ── Monitor class ──────────────────────────────────────────────

export interface WorkerCompletionMonitorConfig {
  readonly logger: Logger;
  readonly eventBus: EventBus;
}

/**
 * Assesses worker closeout status from raw evidence.
 *
 * DESIGN: Stateless assessment — all context comes via the input parameter.
 * Emits a `worker.closeout_assessed` event for every assessment, enabling
 * audit and monitoring without coupling to the assessment caller.
 */
export class WorkerCompletionMonitor {
  readonly #logger: Logger;
  readonly #eventBus: EventBus;

  constructor(config: WorkerCompletionMonitorConfig) {
    this.#logger = config.logger;
    this.#eventBus = config.eventBus;
  }

  /**
   * Derive closeout status from available evidence.
   *
   * Decision tree:
   * 1. Running/pending → in_progress
   * 2. Completed with valid branch + commit, no review → ready_for_review
   * 3. Completed with open review findings → review_open
   * 4. Completed with all findings resolved → done
   * 5. Failed with recovery guidance → blocked
   * 6. Completed but missing metadata → malformed
   */
  assessCloseout(input: WorkerCompletionAssessInput): WorkerCompletionStatus {
    const packet = extractPacket(input.completionPacket);
    const review = input.reviewWorkflow;
    const rawStatus = input.rawStatus.toLowerCase();

    // 1. Still running or pending
    if (rawStatus === "running" || rawStatus === "pending") {
      return this.#finalize(input, "in_progress", false, "Wait for worker completion", []);
    }

    // 2. Completed — validate evidence
    if (rawStatus === "completed") {
      return this.#assessCompleted(input, packet, review);
    }

    // 3. Failed
    if (rawStatus === "failed") {
      const guidance = packet.recoveryGuidance ?? "Investigate failure; consider reassignment with adjusted policy.";
      return this.#finalize(input, "blocked", false, guidance, [
        `task:${input.taskId}`,
        `assignment:${input.assignmentId}`,
        `run:${input.runId}`,
        `failure:${packet.failureCategory ?? "unknown"}`,
      ]);
    }

    // 4. Malformed or unknown status
    const defaultGuidance = "Worker returned unrecognized status. Investigate assignment logs and consider manual review.";
    const guidance = packet.recoveryGuidance ?? defaultGuidance;
    return this.#finalize(input, "malformed", false, guidance, [
      `task:${input.taskId}`,
      `assignment:${input.assignmentId}`,
      `run:${input.runId}`,
      `raw_status:${input.rawStatus}`,
    ]);
  }

  /**
   * Format a channel-visible markdown status report.
   *
   * DESIGN: Never claims "done" without evidence. If closeoutStatus is "done"
   * but the packet is missing or invalid, the report notes this discrepancy.
   */
  formatChannelReport(status: WorkerCompletionStatus): string {
    const lines: string[] = [
      `## Worker Closeout Report`,
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Task | ${status.taskId} |`,
      `| Assignment | ${status.assignmentId} |`,
      `| Run | ${status.runId} |`,
      `| Status | ${status.status} |`,
      `| Closeout | ${status.closeoutStatus} |`,
      `| Ready for review | ${status.readyForReview} |`,
    ];

    if (status.completionPacket) {
      lines.push(`| Branch | ${status.completionPacket.branch ?? "not reported"} |`);
      lines.push(`| Head commit | ${status.completionPacket.headCommit ?? "not reported"} |`);
      lines.push(`| Tests run | ${status.completionPacket.testsRun ?? "not reported"} |`);
      if (status.completionPacket.artifactKind) {
        lines.push(`| Artifact kind | ${status.completionPacket.artifactKind} |`);
      }
    }

    if (status.reviewState) {
      lines.push(`| Review rounds | ${status.reviewState.roundCount} |`);
      lines.push(`| Unresolved findings | ${status.reviewState.unresolvedFindings} |`);
    }

    if (status.evidenceHandles.length > 0) {
      lines.push("", `**Evidence:** ${status.evidenceHandles.join(", ")}`);
    }

    lines.push("", `**Next action:** ${status.nextAction}`);

    // DESIGN: Guard against premature "done" claims
    if (status.closeoutStatus === "done" && !status.completionPacket?.headCommit) {
      lines.push("", "> ⚠️ Closeout claims 'done' but no head commit evidence present.");
      this.#logger.warn("Closeout claims done without head commit evidence", {
        taskId: status.taskId,
        assignmentId: status.assignmentId,
      });
    }

    return lines.join("\n");
  }

  // ── Private helpers ──────────────────────────────────────────

  #assessCompleted(
    input: WorkerCompletionAssessInput,
    packet: ExtractedPacket,
    review: WorkerCompletionAssessInput["reviewWorkflow"],
  ): WorkerCompletionStatus {
    const handles: string[] = [
      `task:${input.taskId}`,
      `assignment:${input.assignmentId}`,
      `run:${input.runId}`,
    ];

    // Check for valid evidence
    const hasBranch = typeof packet.branch === "string" && packet.branch.length > 0;
    const hasCommit = typeof packet.headCommit === "string" && packet.headCommit.length > 0;

    if (hasBranch) handles.push(`branch:${packet.branch}`);
    if (hasCommit) handles.push(`commit:${packet.headCommit}`);

    // Malformed if missing required metadata
    if (!hasBranch && !hasCommit) {
      const guidance = packet.recoveryGuidance ?? "Completed packet missing branch and head_commit. Re-assign with instructions to report git metadata.";
      return this.#finalize(input, "malformed", false, guidance, handles);
    }

    if (!hasBranch) {
      const guidance = packet.recoveryGuidance ?? "Completed packet missing branch. Verify worker reported git state.";
      return this.#finalize(input, "malformed", false, guidance, handles);
    }

    if (!hasCommit) {
      const guidance = packet.recoveryGuidance ?? "Completed packet missing head_commit. Verify worker reported git state.";
      return this.#finalize(input, "malformed", false, guidance, handles);
    }

    // Valid completed — check review state
    if (review && review.roundCount > 0) {
      if (review.unresolvedFindings > 0) {
        handles.push(`review_rounds:${review.roundCount}`, `open_findings:${review.unresolvedFindings}`);
        return this.#finalize(input, "review_open", false, `Resolve ${review.unresolvedFindings} open review finding(s) before merge.`, handles);
      }
      // All findings resolved
      handles.push(`review_rounds:${review.roundCount}`, "all_findings_resolved");
      return this.#finalize(input, "done", true, "Task complete. All review findings resolved. Ready to merge or close.", handles);
    }

    // No review yet — ready for review
    if (input.workerRole === "coder") {
      return this.#finalize(input, "ready_for_review", true, "Assign reviewer to validate changes.", handles);
    }

    // Non-coder completion without review
    return this.#finalize(input, "done", true, "Task complete. No review required for this role.", handles);
  }

  #finalize(
    input: WorkerCompletionAssessInput,
    closeoutStatus: CloseoutStatus,
    readyForReview: boolean,
    nextAction: string,
    evidenceHandles: readonly string[],
  ): WorkerCompletionStatus {
    const status: WorkerCompletionStatus = {
      assignmentId: input.assignmentId,
      runId: input.runId,
      taskId: input.taskId,
      status: input.rawStatus,
      completionPacket: input.completionPacket
        ? {
            status: String(input.completionPacket["status"] ?? input.rawStatus),
            branch: input.completionPacket["branch"] as string | null | undefined,
            headCommit: input.completionPacket["head_commit"] as string | null | undefined,
            testsRun: input.completionPacket["tests_run"] as boolean | null | undefined,
            artifactKind: input.completionPacket["artifact_kind"] as string | undefined,
            failureCategory: input.completionPacket["failure_category"] as string | undefined,
            recoveryGuidance: input.completionPacket["recovery_guidance"] as string | undefined,
          }
        : undefined,
      reviewState: input.reviewWorkflow,
      readyForReview,
      closeoutStatus,
      nextAction,
      evidenceHandles,
    };

    this.#eventBus.emit({
      event: "worker.closeout_assessed",
      payload: {
        taskId: input.taskId,
        assignmentId: input.assignmentId,
        runId: input.runId,
        closeoutStatus,
        readyForReview,
        workerRole: input.workerRole,
      },
    });

    return status;
  }
}

// ── Helpers ────────────────────────────────────────────────────

interface ExtractedPacket {
  readonly branch?: string | null;
  readonly headCommit?: string | null;
  readonly testsRun?: boolean | null;
  readonly artifactKind?: string;
  readonly failureCategory?: string;
  readonly recoveryGuidance?: string;
}

function extractPacket(raw?: Record<string, unknown>): ExtractedPacket {
  if (!raw) return {};
  return {
    branch: raw["branch"] as string | null | undefined,
    headCommit: raw["head_commit"] as string | null | undefined,
    testsRun: raw["tests_run"] as boolean | null | undefined,
    artifactKind: raw["artifact_kind"] as string | undefined,
    failureCategory: raw["failure_category"] as string | undefined,
    recoveryGuidance: raw["recovery_guidance"] as string | undefined,
  };
}
