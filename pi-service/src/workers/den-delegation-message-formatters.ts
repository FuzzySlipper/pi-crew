/** Channel projection message formatters for delegation lifecycle events. */
import type {
  DelegationCompletedPayload,
  DelegationKilledPayload,
  DelegationOrphanDetectedPayload,
  DelegationSpawnedPayload,
  DelegationTimeoutPayload,
  DelegationToolVisiblePayload,
} from "@pi-crew/core";

const PROJECT_TOOL_CALLED_EVENTS = false;

export interface ProjectedMessage {
  readonly eventName: string;
  readonly summary: string;
  readonly details: Record<string, unknown>;
}

export function formatSpawnedMessage(payload: DelegationSpawnedPayload): ProjectedMessage {
  return {
    eventName: "delegation.spawned",
    summary: `Subagent spawned: depth ${payload.lineage.depth}, profile ${payload.effectiveRuntime?.profileId ?? "unknown"}`,
    details: {
      childSessionId: payload.childSessionId,
      parentSessionId: payload.lineage.parentSessionId,
      rootSessionId: payload.lineage.rootSessionId,
      depth: payload.lineage.depth,
      profileId: payload.effectiveRuntime?.profileId,
      provider: payload.effectiveRuntime?.provider,
      model: payload.effectiveRuntime?.model,
      task: payload.task?.slice(0, 200),
      policyId: payload.policyId,
    },
  };
}

export function formatCompletedMessage(payload: DelegationCompletedPayload): ProjectedMessage {
  return {
    eventName: "delegation.completed",
    summary: `Subagent completed: ${payload.result.outcome} — ${payload.result.summary.slice(0, 200)}`,
    details: {
      childSessionId: payload.childSessionId,
      profileId: payload.result.effectiveRuntime?.profileId,
      provider: payload.result.effectiveRuntime?.provider,
      model: payload.result.effectiveRuntime?.model,
      outcome: payload.result.outcome,
      failureCategory: payload.result.failureCategory,
      tokensConsumed: payload.result.tokensConsumed,
      turnsUsed: payload.result.turnsUsed,
      durationMs: payload.result.durationMs,
      error: payload.result.error,
      recoveryGuidance: payload.result.recoveryGuidance,
      evidenceChecked: payload.result.evidenceChecked,
      structureRepair: payload.result.structureRepair,
      artifactCount: payload.result.artifacts?.length ?? 0,
    },
  };
}

export function formatKilledMessage(payload: DelegationKilledPayload): ProjectedMessage {
  return {
    eventName: "delegation.killed",
    summary: `Subagent killed: ${payload.reason} (initiated by ${payload.initiatedBy})`,
    details: {
      childSessionId: payload.childSessionId,
      reason: payload.reason,
      initiatedBy: payload.initiatedBy,
      lineage: payload.lineage,
    },
  };
}

export function formatTimeoutMessage(payload: DelegationTimeoutPayload): ProjectedMessage {
  return {
    eventName: "delegation.timeout",
    summary: `Subagent timed out: ${String(payload.elapsedMs)}ms elapsed, ${String(payload.timeoutMs)}ms limit`,
    details: {
      childSessionId: payload.childSessionId,
      timeoutMs: payload.timeoutMs,
      elapsedMs: payload.elapsedMs,
    },
  };
}

export function formatOrphanMessage(payload: DelegationOrphanDetectedPayload): ProjectedMessage {
  return {
    eventName: "delegation.orphan_detected",
    summary: `Subagent orphaned: session ${payload.orphanSessionId}, idle ${String(payload.idleDurationMs)}ms`,
    details: {
      orphanSessionId: payload.orphanSessionId,
      lastKnownParentSessionId: payload.lastKnownParentSessionId,
      idleDurationMs: payload.idleDurationMs,
    },
  };
}

export function formatToolVisibleMessage(
  payload: DelegationToolVisiblePayload,
  projectToolCalledEvents: boolean = PROJECT_TOOL_CALLED_EVENTS,
): ProjectedMessage | null {
  if (payload.phase === "called" && !projectToolCalledEvents) return null;
  const summary =
    payload.phase === "completed"
      ? `Subagent used tool: ${payload.toolName} completed (${String(payload.durationMs ?? 0)}ms)`
      : payload.phase === "denied"
        ? `Subagent tool denied: ${payload.toolName} — ${payload.reason ?? "policy"}`
        : `Subagent tool called: ${payload.toolName}`;
  return {
    eventName: "delegation.tool_visible",
    summary,
    details: {
      childSessionId: payload.childSessionId,
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      phase: payload.phase,
      durationMs: payload.durationMs,
      reason: payload.reason,
    },
  };
}
