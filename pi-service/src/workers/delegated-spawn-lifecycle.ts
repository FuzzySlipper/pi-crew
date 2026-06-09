/** Service-level delegated session spawn lifecycle. */

import type {
  DelegatedResult,
  DelegationConstraints,
  DelegationLineage,
  DelegationSpawnRequest,
  DelegationToolVisiblePayload,
  DelegationTurnVisiblePayload,
  DelegationVisibilityPayload,
  EffectiveDelegationRuntime,
  EventBus,
  ExecutionPolicy,
  HookRegistry,
  Logger,
  Result,
} from "@pi-crew/core";
import { createChildDelegationLineage, err, ok } from "@pi-crew/core";
import { deriveChildExecutionPolicy } from "@pi-crew/tools";
import type {
  DelegatedSessionCreateRequest,
  DelegationSessionBridge,
  DelegationVisibilityEvent,
  ServiceSessionView,
} from "../extension-activator.js";

export interface DelegatedSpawnLifecycleConfig {
  readonly hookRegistry: HookRegistry;
  readonly delegationSessions: DelegationSessionBridge;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly childRunner: DelegatedChildRunner;
  readonly childSessionId?: () => string;
}

export interface DelegatedSpawnInput {
  readonly parentSessionId: string;
  readonly task: string;
  readonly parentPolicy: ExecutionPolicy;
  readonly parentDelegationConstraints: DelegationConstraints;
  readonly parentLineage?: DelegationLineage | null;
  readonly parentRuntime: EffectiveDelegationRuntime;
  readonly allowedRuntimes?: readonly EffectiveDelegationRuntime[];
  readonly requestedPolicy?: DelegatedPolicyRequest;
  readonly spawnRequest?: DelegationSpawnRequest;
  readonly correlation?: DelegatedSpawnCorrelation;
}

export interface DelegatedSpawnCorrelation {
  readonly policyId?: string;
  readonly assignmentId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly profileId?: string;
}

export interface DelegatedPolicyRequest {
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly denyPaths?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly deniedHosts?: readonly string[];
  readonly credentialScope?: ExecutionPolicy["credentialScope"];
  readonly maxDurationMs?: number;
  readonly maxTurnDurationMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxIterations?: number;
  readonly maxTokensPerTurn?: number;
  readonly maxSpawnDepth?: number;
  readonly maxConcurrentChildren?: number;
}

export interface DelegatedChildRunInput {
  readonly childSession: ServiceSessionView;
  readonly policy: ExecutionPolicy;
  readonly delegationConstraints: DelegationConstraints;
  readonly lineage: DelegationLineage;
  readonly spawnRequest: DelegationSpawnRequest;
  readonly effectiveRuntime: EffectiveDelegationRuntime;
  readonly correlation: DelegatedSpawnCorrelation;
  readonly signal: AbortSignal;
  emitTurnVisible(input: DelegatedTurnVisibilityInput): Promise<void>;
  emitToolVisible(input: DelegatedToolVisibilityInput): Promise<void>;
}

export interface DelegatedChildRunner {
  run(input: DelegatedChildRunInput): Promise<DelegatedResult>;
}

export type DelegatedSpawnErrorCode =
  | "parent_session_missing"
  | "max_depth_exceeded"
  | "max_concurrent_children_exceeded"
  | "unsupported_model_selection"
  | "policy_derivation_denied"
  | "spawn_gate_denied"
  | "child_session_create_failed"
  | "child_policy_lookup_failed"
  | "child_execution_failed";

export interface DelegatedSpawnError {
  readonly code: DelegatedSpawnErrorCode;
  readonly message: string;
  readonly detail?: string;
}

export type DelegatedTurnVisibilityInput = Pick<
  DelegationTurnVisiblePayload,
  "turnNumber" | "phase" | "durationMs" | "error"
>;

export type DelegatedToolVisibilityInput = Pick<
  DelegationToolVisiblePayload,
  "toolName" | "toolCallId" | "phase" | "durationMs" | "reason"
>;

interface VisibilityIdentity {
  readonly childSessionId: string;
  readonly lineage: DelegationLineage;
  readonly policyId: string;
  readonly spawnRequestId?: string;
  readonly correlation: DelegatedSpawnCorrelation;
}

let defaultChildCounter = 0;

export class DelegatedSpawnLifecycle {
  readonly #hookRegistry: HookRegistry;
  readonly #bridge: DelegationSessionBridge;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #childRunner: DelegatedChildRunner;
  readonly #childSessionId: () => string;

  constructor(config: DelegatedSpawnLifecycleConfig) {
    this.#hookRegistry = config.hookRegistry;
    this.#bridge = config.delegationSessions;
    this.#eventBus = config.eventBus;
    this.#logger = config.logger;
    this.#childRunner = config.childRunner;
    this.#childSessionId = config.childSessionId ?? nextChildSessionId;
  }

  async spawn(input: DelegatedSpawnInput): Promise<Result<DelegatedResult, DelegatedSpawnError>> {
    const parent = await this.#bridge.getSession(input.parentSessionId);
    if (parent === null) return fail("parent_session_missing", "Parent session is not active");
    if (input.parentDelegationConstraints.maxSpawnDepth <= 0) {
      return fail("max_depth_exceeded", "Parent session has no remaining delegation depth");
    }

    const childCount = await this.#bridge.countChildSessions(input.parentSessionId);
    const maxChildren = input.parentDelegationConstraints.maxConcurrentChildren;
    if (maxChildren !== undefined && childCount >= maxChildren) {
      return fail("max_concurrent_children_exceeded", "Parent session already has maximum active children");
    }

    const spawnRequest = normalizeSpawnRequest(input);
    const runtimeResult = resolveEffectiveRuntime(
      input.parentRuntime,
      input.allowedRuntimes ?? [input.parentRuntime],
      spawnRequest.modelSelection,
    );
    if (!runtimeResult.ok) return runtimeResult;

    const childSessionId = this.#childSessionId();
    const lineage = createChildDelegationLineage({
      parentSessionId: input.parentSessionId,
      childSessionId,
      parentLineage: input.parentLineage,
    });
    const policyResult = deriveChildExecutionPolicy({
      parentPolicy: input.parentPolicy,
      lineage,
      parentDelegationConstraints: input.parentDelegationConstraints,
      requestedPolicy: input.requestedPolicy,
      spawnRequest,
      policyId: `delegated-${childSessionId}`,
    });
    if (!policyResult.ok) {
      return fail("policy_derivation_denied", policyResult.error.message, policyResult.error.code);
    }

    const gate = await this.#hookRegistry.fire("before_session_create", {
      profileId: runtimeResult.value.profileId,
      kind: "delegated",
      channelBindings: [],
      delegation: lineage,
      delegationSpawnRequest: spawnRequest,
    });
    if (!gate.proceed) return fail("spawn_gate_denied", gate.reason);

    const childResult = await this.createRunAndCleanup({
      input,
      lineage,
      spawnRequest,
      effectiveRuntime: runtimeResult.value,
      policy: policyResult.value.policy,
      delegationConstraints: policyResult.value.delegationConstraints,
    });
    return childResult;
  }

  private async createRunAndCleanup(context: {
    readonly input: DelegatedSpawnInput;
    readonly lineage: DelegationLineage;
    readonly spawnRequest: DelegationSpawnRequest;
    readonly effectiveRuntime: EffectiveDelegationRuntime;
    readonly policy: ExecutionPolicy;
    readonly delegationConstraints: DelegationConstraints;
  }): Promise<Result<DelegatedResult, DelegatedSpawnError>> {
    let child: ServiceSessionView;
    try {
      child = await this.#bridge.createDelegatedSession({
        sessionId: context.lineage.childSessionId,
        parentSessionId: context.input.parentSessionId,
        profileId: context.effectiveRuntime.profileId,
        policy: context.policy,
        effectiveRuntime: context.effectiveRuntime,
        delegationConstraints: context.delegationConstraints,
        visibility: {
          lineage: context.lineage,
          spawnRequest: context.spawnRequest,
          effectiveRuntime: context.effectiveRuntime,
        },
      } satisfies DelegatedSessionCreateRequest);
    } catch (cause) {
      return fail("child_session_create_failed", "Delegated child session creation failed", stringifyCause(cause));
    }

    const bridgePolicy = await this.#bridge.getParentExecutionPolicy(child.sessionId);
    if (bridgePolicy === null) {
      await this.#bridge.killChildSession(child.sessionId, "policy lookup failed");
      await this.#bridge.archiveChildSession(child.sessionId, "policy lookup failed");
      return fail("child_policy_lookup_failed", "Delegated child policy lookup failed");
    }

    const visibility = this.visibilityIdentity(context, child);
    await this.emitSpawned(visibility, context.spawnRequest, context.effectiveRuntime);
    const abort = new AbortController();
    const startedAt = Date.now();
    try {
      const runPromise = this.#childRunner.run({
        childSession: child,
        policy: context.policy,
        delegationConstraints: context.delegationConstraints,
        lineage: context.lineage,
        spawnRequest: context.spawnRequest,
        effectiveRuntime: context.effectiveRuntime,
        correlation: visibility.correlation,
        signal: abort.signal,
        emitTurnVisible: (input) => this.emitTurnVisible(visibility, input),
        emitToolVisible: (input) => this.emitToolVisible(visibility, input),
      });
      const result = await withTimeout({
        runPromise,
        timeoutMs: context.spawnRequest.timeoutMs ?? context.policy.maxDurationMs,
        childSessionId: child.sessionId,
        policyId: context.policy.policyId,
        effectiveRuntime: context.effectiveRuntime,
        startedAt,
        abort,
      });
      await this.cleanupForResult(child.sessionId, result);
      await this.emitCompleted(visibility, result);
      return ok(result);
    } catch (cause) {
      await this.#bridge.killChildSession(child.sessionId, "child execution failed");
      await this.#bridge.archiveChildSession(child.sessionId, "child execution failed");
      return fail("child_execution_failed", "Delegated child execution failed", stringifyCause(cause));
    }
  }

  private visibilityIdentity(context: {
    readonly input: DelegatedSpawnInput;
    readonly lineage: DelegationLineage;
    readonly policy: ExecutionPolicy;
  }, child: ServiceSessionView): VisibilityIdentity {
    return {
      childSessionId: child.sessionId,
      lineage: context.lineage,
      policyId: context.policy.policyId,
      correlation: {
        ...context.input.correlation,
        profileId: child.profileId,
      },
    };
  }

  private async cleanupForResult(childSessionId: string, result: DelegatedResult): Promise<void> {
    if (result.outcome === "timeout") {
      await this.#bridge.killChildSession(childSessionId, "timeout");
      await this.#bridge.archiveChildSession(childSessionId, "timeout");
      return;
    }
    if (result.outcome === "killed") {
      await this.#bridge.killChildSession(childSessionId, "killed");
      await this.#bridge.archiveChildSession(childSessionId, "killed");
      return;
    }
    await this.#bridge.releaseChildSession(childSessionId, result.outcome === "success" ? "completed" : "failed");
    await this.#bridge.archiveChildSession(childSessionId, result.outcome === "success" ? "completed" : "failed");
  }

  private async emitSpawned(
    visibility: VisibilityIdentity,
    spawnRequest: DelegationSpawnRequest,
    effectiveRuntime: EffectiveDelegationRuntime,
  ): Promise<void> {
    const payload = {
      ...basePayload(visibility),
      task: spawnRequest.task,
      spawnRequest,
      effectiveRuntime,
      correlation: visibility.correlation,
    };
    this.#eventBus.emit({ event: "delegation.spawned", payload });
    await this.emitBridgeVisibility("delegation.spawned", visibility, payload);
  }

  private async emitTurnVisible(
    visibility: VisibilityIdentity,
    input: DelegatedTurnVisibilityInput,
  ): Promise<void> {
    const payload = { ...basePayload(visibility), ...input };
    this.#eventBus.emit({ event: "delegation.turn_visible", payload });
    await this.emitBridgeVisibility("delegation.turn_visible", visibility, payload);
  }

  private async emitToolVisible(
    visibility: VisibilityIdentity,
    input: DelegatedToolVisibilityInput,
  ): Promise<void> {
    const payload = { ...basePayload(visibility), ...input };
    this.#eventBus.emit({ event: "delegation.tool_visible", payload });
    await this.emitBridgeVisibility("delegation.tool_visible", visibility, payload);
  }

  private async emitCompleted(visibility: VisibilityIdentity, result: DelegatedResult): Promise<void> {
    if (result.outcome === "timeout") {
      const elapsedMs = result.durationMs ?? 0;
      const timeoutPayload = { ...basePayload(visibility), timeoutMs: elapsedMs, elapsedMs };
      this.#eventBus.emit({ event: "delegation.timeout", payload: timeoutPayload });
      await this.emitBridgeVisibility("delegation.timeout", visibility, timeoutPayload);
      await this.emitKilled(visibility, "timeout", "timeout");
    }
    if (result.outcome === "killed") {
      await this.emitKilled(visibility, "killed", "parent");
    }
    const payload = { ...basePayload(visibility), result };
    this.#eventBus.emit({ event: "delegation.completed", payload });
    await this.emitBridgeVisibility("delegation.completed", visibility, payload);
    this.#logger.info("Delegated child completed", {
      childSessionId: visibility.childSessionId,
      outcome: result.outcome,
    });
  }

  private async emitKilled(
    visibility: VisibilityIdentity,
    reason: string,
    initiatedBy: "parent" | "timeout" | "orphan_detected",
  ): Promise<void> {
    const payload = { ...basePayload(visibility), reason, initiatedBy };
    this.#eventBus.emit({ event: "delegation.killed", payload });
    await this.emitBridgeVisibility("delegation.killed", visibility, payload);
  }

  private async emitBridgeVisibility(
    eventType: string,
    visibility: VisibilityIdentity,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.#bridge.emitVisibilityEvent({
      sessionId: visibility.childSessionId,
      eventType,
      metadata,
    } satisfies DelegationVisibilityEvent);
  }
}

function normalizeSpawnRequest(input: DelegatedSpawnInput): DelegationSpawnRequest {
  return {
    task: input.spawnRequest?.task ?? input.task,
    modelSelection: input.spawnRequest?.modelSelection,
    allowedTools: input.spawnRequest?.allowedTools,
    deniedTools: input.spawnRequest?.deniedTools,
    maxSpawnDepth: input.spawnRequest?.maxSpawnDepth,
    timeoutMs: input.spawnRequest?.timeoutMs,
  };
}

function resolveEffectiveRuntime(
  parentRuntime: EffectiveDelegationRuntime,
  allowedRuntimes: readonly EffectiveDelegationRuntime[],
  requested: DelegationSpawnRequest["modelSelection"],
): Result<EffectiveDelegationRuntime, DelegatedSpawnError> {
  const candidate: EffectiveDelegationRuntime = {
    profileId: requested?.profileId ?? parentRuntime.profileId,
    provider: requested?.provider ?? parentRuntime.provider,
    model: requested?.model ?? parentRuntime.model,
  };
  if (allowedRuntimes.some((runtime) => sameRuntime(runtime, candidate))) return ok({ ...candidate });
  return fail("unsupported_model_selection", "Requested child model/profile/provider is not allowed");
}

function sameRuntime(left: EffectiveDelegationRuntime, right: EffectiveDelegationRuntime): boolean {
  return left.profileId === right.profileId && left.provider === right.provider && left.model === right.model;
}

async function withTimeout(input: {
  readonly runPromise: Promise<DelegatedResult>;
  readonly timeoutMs: number;
  readonly childSessionId: string;
  readonly policyId: string;
  readonly effectiveRuntime: EffectiveDelegationRuntime;
  readonly startedAt: number;
  readonly abort: AbortController;
}): Promise<DelegatedResult> {
  if (input.timeoutMs <= 0) return timeoutResult(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.runPromise,
      new Promise<DelegatedResult>((resolve) => {
        timer = setTimeout(() => {
          input.abort.abort();
          resolve(timeoutResult(input));
        }, input.timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function timeoutResult(input: {
  readonly childSessionId: string;
  readonly policyId: string;
  readonly effectiveRuntime: EffectiveDelegationRuntime;
  readonly startedAt: number;
}): DelegatedResult {
  return {
    outcome: "timeout",
    summary: "Delegated child exceeded its execution timeout",
    policyId: input.policyId,
    childSessionId: input.childSessionId,
    effectiveRuntime: input.effectiveRuntime,
    durationMs: Date.now() - input.startedAt,
  };
}

function fail(
  code: DelegatedSpawnErrorCode,
  message: string,
  detail?: string,
): Result<never, DelegatedSpawnError> {
  return err({ code, message, detail });
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function basePayload(visibility: VisibilityIdentity): DelegationVisibilityPayload {
  return {
    ...visibility.correlation,
    childSessionId: visibility.childSessionId,
    lineage: visibility.lineage,
    policyId: visibility.policyId,
    spawnRequestId: visibility.spawnRequestId,
  };
}

function nextChildSessionId(): string {
  defaultChildCounter += 1;
  return `delegated-session-${String(defaultChildCounter)}`;
}
