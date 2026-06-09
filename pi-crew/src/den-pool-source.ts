/** Den worker-pool source helpers for pi-crew installed service readiness. */

import { ConfigurationError } from "@pi-crew/core";
import type { MCPClient, ToolCallContentBlock } from "@pi-crew/mcp";
import type { WorkerBinding } from "@pi-crew/service";

export interface DenPoolMemberReadiness {
  readonly profileReady: boolean;
  readonly modelReady: boolean;
  readonly mcpReady: boolean;
  readonly completionReady: boolean;
}

export interface DenPoolMemberConfig {
  readonly workerIdentity: string;
  readonly profileIdentity: string;
  readonly role: string;
  readonly displayName?: string;
  readonly capabilities?: readonly string[];
  readonly profileId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly readiness?: DenPoolMemberReadiness;
}

export interface DenPoolMemberReconcilerConfig {
  readonly mcpClient: MCPClient;
  readonly assignedBy: string;
  readonly members: readonly DenPoolMemberConfig[];
}

export interface DegradedPoolMember {
  readonly workerIdentity: string;
  readonly reason: string;
}

export interface DenPoolMemberReconcileResult {
  readonly registered: string[];
  readonly degraded: DegradedPoolMember[];
}

export interface DenPoolMemberReconciler {
  reconcile(): Promise<DenPoolMemberReconcileResult>;
}

export interface DenPoolAssignmentConsumerConfig {
  readonly mcpClient: MCPClient;
  readonly member: DenPoolMemberConfig;
}

export interface AssignmentReadback {
  readonly workerIdentity: string;
  readonly profileIdentity: string;
  readonly role: string;
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string;
}

export type DenPoolAssignmentResult =
  | {
      readonly status: "assignment";
      readonly binding: WorkerBinding;
      readonly readback: AssignmentReadback;
    }
  | {
      readonly status: "no_assignment";
      readonly reason: string;
      readonly diagnostic: string;
    };

export interface DenPoolAssignmentConsumer {
  consumeNextAssignment(): Promise<DenPoolAssignmentResult>;
}

interface RawAssignmentEnvelope {
  readonly id: unknown;
  readonly state: unknown;
  readonly project_id: unknown;
  readonly task_id: unknown;
  readonly run_id: unknown;
  readonly role: unknown;
  readonly worker_identity: unknown;
}

interface ParsedToolPayload {
  readonly result?: unknown;
}

export class DenPoolSourceConfigurationError extends ConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = "DenPoolSourceConfigurationError";
  }
}

export function createDenPoolMemberReconciler(
  config: DenPoolMemberReconcilerConfig,
): DenPoolMemberReconciler {
  return new McpDenPoolMemberReconciler(config);
}

export function createDenPoolAssignmentConsumer(
  config: DenPoolAssignmentConsumerConfig,
): DenPoolAssignmentConsumer {
  return new McpDenPoolAssignmentConsumer(config);
}

class McpDenPoolMemberReconciler implements DenPoolMemberReconciler {
  readonly #config: DenPoolMemberReconcilerConfig;

  constructor(config: DenPoolMemberReconcilerConfig) {
    this.#config = config;
  }

  async reconcile(): Promise<DenPoolMemberReconcileResult> {
    const registered: string[] = [];
    const degraded: DegradedPoolMember[] = [];

    for (const member of this.#config.members) {
      const degradedReason = readinessFailure(member.readiness);
      if (degradedReason !== undefined) {
        degraded.push({ workerIdentity: member.workerIdentity, reason: degradedReason });
        continue;
      }

      const params: Record<string, unknown> = {
        worker_identity: member.workerIdentity,
        profile_identity: member.profileIdentity,
        worker_role: member.role,
        display_name: member.displayName ?? member.workerIdentity,
        capabilities: JSON.stringify(member.capabilities ?? []),
        status: "available",
      };
      if (member.metadata !== undefined) {
        params["metadata"] = JSON.stringify(member.metadata);
      }

      const result = await this.#config.mcpClient.callTool("upsert_pool_member", params);

      if (!result.ok) {
        throw new DenPoolSourceConfigurationError(
          `Den pool member reconciliation failed for ${member.workerIdentity}: ${result.error ?? "unknown Den MCP error"}`,
        );
      }

      registered.push(member.workerIdentity);
    }

    return { registered, degraded };
  }
}

class McpDenPoolAssignmentConsumer implements DenPoolAssignmentConsumer {
  readonly #config: DenPoolAssignmentConsumerConfig;

  constructor(config: DenPoolAssignmentConsumerConfig) {
    this.#config = config;
  }

  async consumeNextAssignment(): Promise<DenPoolAssignmentResult> {
    const result = await this.#config.mcpClient.callTool("list_assignments", {
      worker_identity: this.#config.member.workerIdentity,
      state: "ack",
      limit: 1,
      verbose: true,
    });

    if (!result.ok) {
      throw new DenPoolSourceConfigurationError(
        `Den assignment read failed for ${this.#config.member.workerIdentity}: ${result.error ?? "unknown Den MCP error"}`,
      );
    }

    const payload = parseToolPayload(result.content);
    const data = payload.result ?? payload;
    if (isNoCapacityPayload(data)) {
      return {
        status: "no_assignment",
        reason: data.reason_code,
        diagnostic: data.diagnostic,
      };
    }
    if (hasEmptyAssignmentsList(data)) {
      return {
        status: "no_assignment",
        reason: "none_available",
        diagnostic: `No ack assignment envelope is available for ${this.#config.member.workerIdentity}.`,
      };
    }

    const envelope = readAssignmentEnvelope(data);
    return buildAssignmentResult(this.#config.member, envelope);
  }
}

function readinessFailure(readiness: DenPoolMemberReadiness | undefined): string | undefined {
  if (readiness === undefined) return undefined;
  if (!readiness.profileReady) return "profile config is not ready";
  if (!readiness.modelReady) return "model config is not ready";
  if (!readiness.mcpReady) return "MCP config is not ready";
  if (!readiness.completionReady) return "completion config is not ready";
  return undefined;
}

function parseToolPayload(content: ReadonlyArray<ToolCallContentBlock>): ParsedToolPayload {
  const block = content.find((item) => item.type === "text");
  if (block === undefined) {
    throw new DenPoolSourceConfigurationError("Den MCP response did not include text content");
  }

  const parsed = JSON.parse(block.text) as unknown;
  if (!isRecord(parsed)) {
    throw new DenPoolSourceConfigurationError("Den MCP response was not an object");
  }
  return parsed;
}

function readAssignmentEnvelope(data: unknown): RawAssignmentEnvelope {
  if (!isRecord(data)) {
    throw new DenPoolSourceConfigurationError("Den assignment response was not an object");
  }
  const assignment = selectAssignmentRecord(data);
  if (!isRecord(assignment)) {
    throw new DenPoolSourceConfigurationError(
      "Den assignment response did not include an assignment envelope",
    );
  }
  return {
    id: assignment["id"],
    state: assignment["state"],
    project_id: assignment["project_id"],
    task_id: assignment["task_id"],
    run_id: assignment["run_id"],
    role: assignment["role"],
    worker_identity: assignment["worker_identity"],
  };
}

function selectAssignmentRecord(data: Record<string, unknown>): unknown {
  const assignment = data["assignment"];
  if (assignment !== undefined) return assignment;

  const assignments = data["assignments"];
  if (Array.isArray(assignments)) return assignments[0];

  return undefined;
}

function buildAssignmentResult(
  member: DenPoolMemberConfig,
  envelope: RawAssignmentEnvelope,
): DenPoolAssignmentResult {
  const state = requireString(envelope.state, "assignment.state");
  if (state !== "ack" && state !== "running") {
    throw new DenPoolSourceConfigurationError(
      `Den assignment for ${member.workerIdentity} is not claimable: ${state}`,
    );
  }

  const workerIdentity = requireString(envelope.worker_identity, "assignment.worker_identity");
  if (workerIdentity !== member.workerIdentity) {
    throw new DenPoolSourceConfigurationError(
      `Den assignment worker mismatch: expected ${member.workerIdentity}, received ${workerIdentity}`,
    );
  }

  const role = requireString(envelope.role, "assignment.role");
  if (role !== member.role) {
    throw new DenPoolSourceConfigurationError(
      `Den assignment role mismatch: expected ${member.role}, received ${role}`,
    );
  }

  const binding: WorkerBinding = {
    assignmentId: String(requireScalar(envelope.id, "assignment.id")),
    runId: requireString(envelope.run_id, "assignment.run_id"),
    taskId: String(requireScalar(envelope.task_id, "assignment.task_id")),
    projectId: requireString(envelope.project_id, "assignment.project_id"),
    role,
  };

  return {
    status: "assignment",
    binding,
    readback: {
      workerIdentity,
      profileIdentity: member.profileIdentity,
      role,
      assignmentId: binding.assignmentId,
      runId: binding.runId,
      taskId: binding.taskId,
      projectId: binding.projectId,
    },
  };
}

function isNoCapacityPayload(data: unknown): data is { reason_code: string; diagnostic: string } {
  if (!isRecord(data)) return false;
  return typeof data["reason_code"] === "string" && typeof data["diagnostic"] === "string";
}

function hasEmptyAssignmentsList(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const assignments = data["assignments"];
  return Array.isArray(assignments) && assignments.length === 0;
}

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new DenPoolSourceConfigurationError(
    `Invalid Den assignment envelope: ${field} must be a non-empty string`,
  );
}

function requireScalar(value: unknown, field: string): string | number {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new DenPoolSourceConfigurationError(
    `Invalid Den assignment envelope: ${field} must be a string or number`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
