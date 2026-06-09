/** Composition-owned runner from Den pool assignment envelopes to WorkerRuntime. */

import { ConfigurationError } from "@pi-crew/core";
import type { CompletionPacket } from "@pi-crew/core";
import type { MCPClient } from "@pi-crew/mcp";
import type { WorkerBinding, WorkerExecutor } from "@pi-crew/service";
import type { DenPoolAssignmentConsumer } from "./den-pool-source.js";

export interface DenAssignmentRunnerRuntime {
  executeAssignment(binding: WorkerBinding, executor: WorkerExecutor): Promise<CompletionPacket>;
}

export interface DenAssignmentRunnerConfig {
  readonly assignmentConsumer: DenPoolAssignmentConsumer;
  readonly workerRuntime: DenAssignmentRunnerRuntime;
  readonly executorFactory: () => WorkerExecutor;
  readonly mcpClient: MCPClient;
  readonly workerIdentity: string;
}

export type DenAssignmentRunnerResult =
  | {
      readonly status: "no_assignment";
      readonly reason: string;
      readonly diagnostic: string;
    }
  | {
      readonly status: "completed";
      readonly packet: CompletionPacket;
    }
  | {
      readonly status: "failed";
      readonly error: string;
    };

export interface DenAssignmentRunner {
  runOnce(): Promise<DenAssignmentRunnerResult>;
}

export class DenAssignmentRunnerError extends ConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = "DenAssignmentRunnerError";
  }
}

export function createDenAssignmentRunner(config: DenAssignmentRunnerConfig): DenAssignmentRunner {
  return new McpDenAssignmentRunner(config);
}

class McpDenAssignmentRunner implements DenAssignmentRunner {
  readonly #config: DenAssignmentRunnerConfig;

  constructor(config: DenAssignmentRunnerConfig) {
    this.#config = config;
  }

  async runOnce(): Promise<DenAssignmentRunnerResult> {
    const assignment = await this.#config.assignmentConsumer.consumeNextAssignment();
    if (assignment.status === "no_assignment") return assignment;

    let packet: CompletionPacket;
    try {
      packet = await this.#config.workerRuntime.executeAssignment(
        assignment.binding,
        this.#config.executorFactory(),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#postFailureCompletion(assignment.binding, message);
      await this.#recordCleanupEvidence(assignment.binding, {
        workerIdentity: this.#config.workerIdentity,
        runId: assignment.binding.runId,
        taskId: assignment.binding.taskId,
        status: "failed",
        completionPosted: false,
        error: message,
      });
      await this.#releaseAssignment(assignment.binding);
      return { status: "failed", error: message };
    }

    await this.#recordCleanupEvidence(assignment.binding, {
      workerIdentity: this.#config.workerIdentity,
      runId: assignment.binding.runId,
      taskId: assignment.binding.taskId,
      status: packet.status,
      completionPosted: true,
    });
    await this.#releaseAssignment(assignment.binding);
    return { status: "completed", packet };
  }

  async #recordCleanupEvidence(
    binding: WorkerBinding,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.#config.mcpClient.callTool("record_cleanup_evidence", {
      assignment_id: parseAssignmentId(binding.assignmentId),
      evidence: JSON.stringify(evidence),
    });
    if (!result.ok) {
      throw new DenAssignmentRunnerError(
        `Den cleanup evidence failed for assignment ${binding.assignmentId}: ${result.error ?? "unknown MCP error"}`,
      );
    }
  }

  async #postFailureCompletion(binding: WorkerBinding, error: string): Promise<void> {
    const result = await this.#config.mcpClient.callTool("post_worker_completion_packet", {
      project_id: binding.projectId,
      run_id: binding.runId,
      requested_by: this.#config.workerIdentity,
      status: "failed",
      role: binding.role,
      packet_type: resolvePacketType(binding.role),
      summary: `WorkerRuntime failed before structured completion: ${error}`,
      failure_category: "runtime_failure",
      recovery_guidance: "Inspect worker runtime setup and rerun after correcting the failure.",
    });
    if (!result.ok) {
      throw new DenAssignmentRunnerError(
        `Den failed-completion post failed for assignment ${binding.assignmentId}: ${result.error ?? "unknown MCP error"}`,
      );
    }
  }

  async #releaseAssignment(binding: WorkerBinding): Promise<void> {
    const result = await this.#config.mcpClient.callTool("release_assignment", {
      assignment_id: parseAssignmentId(binding.assignmentId),
    });
    if (!result.ok) {
      throw new DenAssignmentRunnerError(
        `Den assignment release failed for assignment ${binding.assignmentId}: ${result.error ?? "unknown MCP error"}`,
      );
    }
  }
}

function parseAssignmentId(assignmentId: string): number {
  const parsed = Number(assignmentId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DenAssignmentRunnerError(
      `Den assignment id must be a positive integer: ${assignmentId}`,
    );
  }
  return parsed;
}

function resolvePacketType(role: string): string {
  if (role === "reviewer") return "review_findings_packet";
  if (role === "validator") return "validation_packet";
  if (role === "drift_checker") return "drift_check_packet";
  if (role === "packet_auditor" || role === "packet-auditor") return "packet_audit_packet";
  return "implementation_packet";
}
