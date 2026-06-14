/** Mapping helpers from delegation events to agent-work breadcrumb DTOs. */
import type {
  DelegationCompletedPayload,
  DelegationKilledPayload,
  DelegationOrphanDetectedPayload,
  DelegationSpawnedPayload,
  DelegationTimeoutPayload,
  DelegationToolVisiblePayload,
  DelegationTurnVisiblePayload,
  DelegationVisibilityPayload,
} from "@pi-crew/core";
import {
  createDelegationBreadcrumb,
  createToolBreadcrumb,
  truncateText,
  type AgentWorkBreadcrumb,
  type AgentWorkBreadcrumbRepository,
  type AgentWorkToolResultClass,
} from "@pi-crew/core";

interface MappingContext {
  readonly projectId: string;
  readonly channelId: string;
  readonly parentAgentIdentity: string;
}

interface ToolCounts {
  readonly called: number;
  readonly completed: number;
}

/** Append/coalesce delegation breadcrumbs into the durable repository. */
export class DelegationBreadcrumbSink {
  readonly #repository: AgentWorkBreadcrumbRepository;
  readonly #context: MappingContext;

  constructor(repository: AgentWorkBreadcrumbRepository, context: MappingContext) {
    this.#repository = repository;
    this.#context = context;
  }

  spawned(payload: DelegationSpawnedPayload): Promise<AgentWorkBreadcrumb> {
    return this.#repository.append(createDelegationBreadcrumb({
      ...baseDelegation(this.#context, payload),
      eventType: "pi_crew.delegation.spawned",
      state: "started",
      severity: "info",
      summary: `Subagent spawned: ${payload.childSessionId}`,
      evidence: { childSessionId: payload.childSessionId },
      metadata: { spawnRequestId: payload.spawnRequestId },
      taskExcerpt: truncateText(payload.task, 300),
    }));
  }

  turn(payload: DelegationTurnVisiblePayload, coalescedTurnCount: number): Promise<AgentWorkBreadcrumb> {
    const completed = payload.phase === "completed";
    const failed = payload.phase === "errored";
    return this.#repository.append(createDelegationBreadcrumb({
      ...baseDelegation(this.#context, payload),
      eventType: completed ? "pi_crew.delegation.turn_completed" : "pi_crew.delegation.turn_started",
      state: failed ? "failed" : completed ? "completed" : "interim",
      severity: failed ? "warn" : "debug",
      summary: `Subagent turn ${payload.phase}: ${payload.childSessionId} turn ${String(payload.turnNumber)}`,
      evidence: { childSessionId: payload.childSessionId },
      metadata: {
        phase: payload.phase,
        turnNumber: payload.turnNumber,
        durationMs: payload.durationMs,
        error: payload.error,
        coalescedTurnCount,
      },
    }));
  }

  tool(payload: DelegationToolVisiblePayload, counts: ToolCounts): Promise<AgentWorkBreadcrumb> {
    const resultClass = toolResultClass(payload);
    const breadcrumb = createToolBreadcrumb({
      projectId: this.#context.projectId,
      channelId: this.#context.channelId,
      eventFamily: "tool",
      eventType: toolEventType(payload),
      state: toolState(payload),
      severity: payload.phase === "denied" ? "warn" : "debug",
      summary: `Subagent tool ${payload.phase}: ${payload.toolName}`,
      evidence: { childSessionId: payload.childSessionId, toolCallId: payload.toolCallId },
      metadata: {
        childSessionId: payload.childSessionId,
        parentSessionId: payload.lineage.parentSessionId,
        rootSessionId: payload.lineage.rootSessionId,
        policyId: payload.policyId,
        phase: payload.phase,
        reason: payload.reason,
      },
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      phase: payload.phase,
      durationMs: payload.durationMs,
      isError: resultClass !== "ok",
      resultClass,
      coalescedToolCallCount: counts.called,
      coalescedCompletedCount: counts.completed,
      ownerSessionId: payload.childSessionId,
    });
    if (payload.phase === "called") return this.#repository.append(breadcrumb);
    return this.#repository.updateByCorrelation(
      { eventFamily: "tool", childSessionId: payload.childSessionId, toolCallId: payload.toolCallId },
      {
        state: breadcrumb.state,
        summary: breadcrumb.summary,
        evidence: breadcrumb.evidence,
        metadata: breadcrumb.metadata,
        phase: breadcrumb.phase,
        durationMs: breadcrumb.durationMs,
        isError: breadcrumb.isError,
        resultClass: breadcrumb.resultClass,
        coalescedToolCallCount: counts.called,
        coalescedCompletedCount: counts.completed,
      },
    ).then((updated) => updated ?? this.#repository.append(breadcrumb));
  }

  completed(payload: DelegationCompletedPayload): Promise<AgentWorkBreadcrumb> {
    const failed = payload.result.outcome !== "success";
    return this.#repository.append(createDelegationBreadcrumb({
      ...baseDelegation(this.#context, payload),
      eventType: failed ? "pi_crew.delegation.failed" : "pi_crew.delegation.completed",
      state: failed ? "failed" : "completed",
      severity: failed ? "warn" : "info",
      summary: `Subagent completed: ${payload.result.outcome}`,
      evidence: { childSessionId: payload.childSessionId },
      metadata: { recoveryGuidance: payload.result.recoveryGuidance },
      outcome: payload.result.outcome,
      durationMs: payload.result.durationMs,
      turnsUsed: payload.result.turnsUsed,
      tokensConsumed: payload.result.tokensConsumed,
      evidenceChecked: payload.result.evidenceChecked,
      artifactCount: payload.result.artifacts?.length ?? 0,
      failureCategory: payload.result.failureCategory,
    }));
  }

  timeout(payload: DelegationTimeoutPayload): Promise<AgentWorkBreadcrumb> {
    return this.#terminal(payload, "pi_crew.delegation.timeout", "timeout", "warn", {
      timeoutMs: payload.timeoutMs,
      elapsedMs: payload.elapsedMs,
    });
  }

  killed(payload: DelegationKilledPayload): Promise<AgentWorkBreadcrumb> {
    return this.#terminal(payload, "pi_crew.delegation.failed", "failed", "warn", {
      reason: payload.reason,
      initiatedBy: payload.initiatedBy,
    });
  }

  orphaned(payload: DelegationOrphanDetectedPayload): Promise<AgentWorkBreadcrumb> {
    const childSessionId = payload.orphanSessionId;
    return this.#repository.append(createDelegationBreadcrumb({
      ...baseDelegation(this.#context, { ...payload, childSessionId }),
      eventType: "pi_crew.delegation.orphaned",
      state: "orphaned",
      severity: "warn",
      summary: `Subagent orphaned: ${childSessionId}`,
      evidence: { childSessionId },
      metadata: {
        lastKnownParentSessionId: payload.lastKnownParentSessionId,
        idleDurationMs: payload.idleDurationMs,
      },
      outcome: "orphaned",
    }));
  }

  #terminal(
    payload: DelegationVisibilityPayload,
    eventType: "pi_crew.delegation.timeout" | "pi_crew.delegation.failed",
    state: "timeout" | "failed",
    severity: "warn",
    metadata: Record<string, unknown>,
  ): Promise<AgentWorkBreadcrumb> {
    return this.#repository.append(createDelegationBreadcrumb({
      ...baseDelegation(this.#context, payload),
      eventType,
      state,
      severity,
      summary: `Subagent ${state}: ${payload.childSessionId}`,
      evidence: { childSessionId: payload.childSessionId },
      metadata,
      outcome: state === "timeout" ? "timeout" : "killed",
    }));
  }
}

function baseDelegation(
  context: MappingContext,
  payload: DelegationVisibilityPayload & {
    readonly effectiveRuntime?: { readonly profileId?: string; readonly provider?: string; readonly model?: string };
  },
) {
  return {
    projectId: context.projectId,
    channelId: context.channelId,
    eventFamily: "delegation" as const,
    parentAgentIdentity: context.parentAgentIdentity,
    parentSessionId: payload.lineage.parentSessionId,
    rootSessionId: payload.lineage.rootSessionId,
    childSessionId: payload.childSessionId,
    profileId: payload.effectiveRuntime?.profileId ?? "unknown",
    provider: payload.effectiveRuntime?.provider,
    model: payload.effectiveRuntime?.model,
    policyId: payload.policyId,
    depth: payload.lineage.depth,
  };
}

function toolEventType(payload: DelegationToolVisiblePayload) {
  if (payload.phase === "denied") return "pi_crew.delegation.tool_denied";
  if (payload.phase === "completed") return "pi_crew.delegation.tool_completed";
  return "pi_crew.delegation.tool_called";
}

function toolState(payload: DelegationToolVisiblePayload) {
  if (payload.phase === "denied") return "denied";
  if (payload.phase === "completed") return "completed";
  return "interim";
}

function toolResultClass(payload: DelegationToolVisiblePayload): AgentWorkToolResultClass {
  if (payload.phase === "denied") return "denied";
  return "ok";
}
