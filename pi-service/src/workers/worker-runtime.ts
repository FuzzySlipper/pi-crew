import type {
  Logger,
  EventBus,
  CompletionPacket,
  CompletionStatus,
  GatewayEvent,
  EventPayload,
  ContextPressureSnapshot,
} from "@pi-crew/core";
import type { CompletionPoster, ContextUsageTracker } from "@pi-crew/tools";
import {
  ContextUsageTrackerImpl,
  DrainModeManager,
  TokenPressureEmitter,
  contextStatusTool,
  createWorkerPolicy,
  postStructuredCompletion,
} from "@pi-crew/tools";
import type { SessionManager } from "../sessions/session-manager.js";
import type { InstancePool } from "../instances/instance-pool.js";
import type { SessionConfig, WorkerBinding, SessionRecord } from "../sessions/types.js";
import type { AuditRepository } from "../persistence/types.js";
import {
  type WorkerRoleConfig,
  type WorkerRoleMappingConfig,
  resolveProfileId,
  resolveRoleConfig,
} from "./worker-role-config.js";
import { createWorkerIdleWatchdog, type IdleTimeoutWatchdog } from "./worker-idle-timeout.js";
import { executeWithAssignmentTimeout } from "./worker-timeout.js";
import { AgentSupervisor, type AgentLike } from "./agent-supervisor.js";
import { PacketAuditorRoleAssembly } from "./packet-auditor-role-assembly.js";
import type { TargetPacketRef, WorkerRoleAssembly, WorkerRoleInput } from "./worker-role-assembly.js";

/**
 * A worker executor implements the role-specific logic for a worker
 * assignment (e.g., packet-auditor validation).
 */
export interface WorkerExecutor {
  /** Execute the worker's role-specific logic. */
  execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult>;
}

/** Context passed to a worker executor. */
export interface WorkerExecutionContext {
  /** The worker binding for this assignment. */
  readonly binding: WorkerBinding;
  /** The session record for this worker. */
  readonly session: SessionRecord;
  /** Role-specific runtime config resolved from injected mapping. */
  readonly roleConfig?: WorkerRoleConfig;
  /** AbortSignal for cooperative cancellation (timeout, drain, etc.). */
  readonly signal?: AbortSignal;
  /** Emit an event on the gateway bus. */
  emitEvent(event: GatewayEvent): void;
  /** Log a message with the worker's correlation context. */
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
  /** Write an audit event with auto-filled correlation IDs. */
  writeAudit(eventType: string, data: Record<string, unknown>): Promise<void>;
  /** Create a supervisor that bridges pi-agent-core Agent events for this assignment. */
  createAgentSupervisor(agent: AgentLike): AgentSupervisor;
  readonly contextUsageTracker: ContextUsageTracker;
  readonly drainModeManager: DrainModeManager;
  contextStatus(): ContextPressureSnapshot;
  /** Build role-assembly input for a supervised Agent construction path. */
  buildWorkerRoleInput(targetPacketRef?: TargetPacketRef): WorkerRoleInput;
  /** Resolve the service-local role assembly for this worker role. */
  getWorkerRoleAssembly(): WorkerRoleAssembly | undefined;
}

/** Result of worker execution. */
export interface WorkerExecutionResult {
  /** Completion status. */
  readonly status: CompletionStatus;
  /** Artifacts produced. */
  readonly artifacts: Array<{
    readonly type: string;
    readonly ref: string;
    readonly summary: string;
  }>;
  /** Files touched. */
  readonly filesTouched: string[];
  /** Tools used. */
  readonly toolsUsed: string[];
  /** Estimated tokens consumed. */
  readonly tokensConsumed: number;
  /** Agent turn count observed by a supervised Agent execution. */
  readonly turnCount?: number;
  /** Execution summary for the completion packet. */
  readonly summary: string;
  /** Optional release reason override for specialized failure paths. */
  readonly releaseReason?: "timeout" | "failed" | "completed";
  /** Blocker details (only when status is "blocked" or "failed"). */
  readonly blocker?: {
    readonly reason: string;
    readonly requires: "human" | "dependency" | "review";
    readonly details: string;
  };
}

/** Configuration for {@link WorkerRuntime}. */
export interface WorkerRuntimeConfig {
  /** Identity of this runtime instance. */
  readonly workerIdentity: string;
}

/**
 * Drives the Den worker lifecycle for a single assignment.
 *
 * 1. Claims the assignment (emits assignment.claimed).
 * 2. Creates a fresh worker session with WorkerBinding.
 * 3. Executes the worker logic via the injected executor with
 *    a hard assignment-duration timeout.
 * 4. Posts a structured CompletionPacket.
 * 5. Releases the assignment (emits assignment.released).
 * 6. Archives the worker session.
 *
 * Role-to-profile resolution is handled via the injected
 * {@link WorkerRoleMappingConfig}, validated at construction
 * time (no duplicate roles, at least one binding required).
 *
 * On timeout, the runtime stops executor work, posts structured
 * failure evidence with correlation IDs, and ensures no orphaned
 * local worker session remains.
 */
export class WorkerRuntime {
  readonly #config: WorkerRuntimeConfig;
  readonly #roleMapping: WorkerRoleMappingConfig;
  readonly #sessionManager: SessionManager;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #auditRepo: AuditRepository;
  readonly #poster?: CompletionPoster;

  constructor(
    config: WorkerRuntimeConfig,
    roleMapping: WorkerRoleMappingConfig,
    sessionManager: SessionManager,
    pool: InstancePool,
    eventBus: EventBus,
    logger: Logger,
    auditRepo: AuditRepository,
    poster?: CompletionPoster,
  ) {
    void pool; // retained for future policy checks, kept in signature for composition
    this.#config = config;
    this.#roleMapping = roleMapping;
    this.#sessionManager = sessionManager;
    this.#eventBus = eventBus;
    this.#logger = logger;
    this.#auditRepo = auditRepo;
    this.#poster = poster;
  }

  /**
   * Execute the full worker lifecycle for an assignment.
   *
   * Enforces a hard assignment-duration timer from claim/start.
   * On timeout, stops executor work, posts failure evidence,
   * and releases the assignment with reason `"timeout"`.
   */
  async executeAssignment(
    binding: WorkerBinding,
    executor: WorkerExecutor,
  ): Promise<CompletionPacket> {
    const startedAt = Date.now();
    const profileId = resolveProfileId(this.#roleMapping, binding.role);
    const roleConfig = resolveRoleConfig(this.#roleMapping, binding.role);

    this.#logLifecycle("claiming", binding);
    this.#emitAssignmentClaimed(binding);

    const session = await this.#createWorkerSession(binding, profileId);
    this.#logLifecycle("session_created", binding, { sessionId: session.id });

    const idleWatchdog = createWorkerIdleWatchdog({
      eventBus: this.#eventBus,
      workerIdentity: this.#config.workerIdentity,
      binding,
      session,
      profileId,
      roleConfig,
    });

    idleWatchdog?.start("executing");
    const context = this.#buildContext(binding, session, roleConfig, profileId, idleWatchdog);

    const result = await executeWithAssignmentTimeout({
      executor,
      context,
      binding,
      session,
      profileId,
      roleConfig,
      startedAt,
      eventBus: this.#eventBus,
      logLifecycle: (
        phase: string,
        target: WorkerBinding | null,
        extra?: Record<string, unknown>,
      ): void => {
        this.#logLifecycle(phase, target, extra);
      },
    });

    const packet = this.#buildCompletionPacket(binding, result, startedAt);
    idleWatchdog?.touch("completing");
    await this.#postCompletion(packet);

    const releaseReason =
      result.releaseReason ?? (packet.status === "completed" ? "completed" : "failed");
    this.#emitAssignmentReleased(binding, releaseReason);
    idleWatchdog?.touch("released");
    idleWatchdog?.stop();

    await this.#cleanupSession(session);

    const durationMs = Date.now() - startedAt;
    this.#logger.info("Worker assignment complete", {
      assignmentId: binding.assignmentId,
      runId: binding.runId,
      role: binding.role,
      status: packet.status,
      durationMs,
    });

    return packet;
  }

  #emitAssignmentClaimed(binding: WorkerBinding): void {
    this.#eventBus.emit({
      event: "assignment.claimed",
      payload: {
        assignmentId: Number(binding.assignmentId),
        workerIdentity: this.#config.workerIdentity,
        taskId: Number(binding.taskId),
      },
    });
  }

  async #createWorkerSession(binding: WorkerBinding, profileId: string): Promise<SessionRecord> {
    const config: SessionConfig = {
      profileId,
      kind: "worker",
      channelBindings: [],
      workerBinding: binding,
    };

    return this.#sessionManager.create(config);
  }

  #buildContext(
    binding: WorkerBinding,
    session: SessionRecord,
    roleConfig: WorkerRoleConfig | undefined,
    profileId: string,
    idleWatchdog?: IdleTimeoutWatchdog,
  ): WorkerExecutionContext {
    const supervisorEventBus = this.#buildSupervisorEventBus(idleWatchdog);
    const contextUsageTracker = new ContextUsageTrackerImpl();
    const pressureEmitter = new TokenPressureEmitter();
    const policyDefaults = roleConfig?.toolPolicyDefaults;
    const policy = createWorkerPolicy({
      assignmentId: binding.assignmentId,
      runId: binding.runId,
      taskId: binding.taskId,
      role: binding.role,
      workdir: policyDefaults?.workdirRoot,
      allowedTools: policyDefaults?.allowedTools,
      deniedTools: policyDefaults?.deniedTools,
      allowedHosts: policyDefaults?.allowedHosts,
      deniedHosts: policyDefaults?.deniedHosts,
      maxDurationMs: policyDefaults?.assignmentTimeoutMs,
      idleTimeoutMs: policyDefaults?.idleTimeoutMs,
    });
    const drainModeManager = new DrainModeManager(
      supervisorEventBus,
      this.#logger,
      session.id,
      policy,
    );
    for (const tool of roleConfig?.drainEssentialTools ?? []) {
      drainModeManager.addEssentialTool(tool);
    }
    return {
      binding,
      session,
      roleConfig,
      contextUsageTracker,
      drainModeManager,
      contextStatus: (): ContextPressureSnapshot =>
        contextStatusTool(
          contextUsageTracker,
          drainModeManager,
          { pressureEmitter },
          supervisorEventBus,
          this.#logger,
          session.id,
        ),
      emitEvent: (event: GatewayEvent): void => {
        idleWatchdog?.touchForEvent(event);
        this.#eventBus.emit(event);
      },
      log: (level: "debug" | "info" | "warn" | "error", message: string): void => {
        this.#logger[level](`[worker] ${message}`, {
          assignmentId: binding.assignmentId,
          runId: binding.runId,
          sessionId: session.id,
        });
      },
      writeAudit: async (eventType: string, data: Record<string, unknown>): Promise<void> => {
        await this.#auditRepo.write({
          sessionId: session.id,
          assignmentId: binding.assignmentId,
          runId: binding.runId,
          eventType,
          eventData: data,
        });
      },
      createAgentSupervisor: (agent: AgentLike): AgentSupervisor =>
        new AgentSupervisor(
          {
            binding,
            sessionId: session.id,
            profileId,
            eventBus: supervisorEventBus,
            logger: this.#logger,
            tokenTracker: contextUsageTracker,
            pressureEmitter,
            drainManager: drainModeManager,
          },
          agent,
        ),
      buildWorkerRoleInput: (targetPacketRef?: TargetPacketRef): WorkerRoleInput => ({
        binding,
        sessionId: session.id,
        profileId,
        roleConfig,
        targetPacketRef,
      }),
      getWorkerRoleAssembly: (): WorkerRoleAssembly | undefined =>
        binding.role === "packet-auditor" || binding.role === "packet_auditor"
          ? PacketAuditorRoleAssembly
          : undefined,
    };
  }

  #buildSupervisorEventBus(idleWatchdog?: IdleTimeoutWatchdog): EventBus {
    return {
      emit: (event: GatewayEvent): void => {
        idleWatchdog?.touchForEvent(event);
        this.#eventBus.emit(event);
      },
      on: <E extends GatewayEvent["event"]>(
        event: E,
        handler: (payload: EventPayload<E>) => void,
      ): (() => void) => this.#eventBus.on(event, handler),
      off: <E extends GatewayEvent["event"]>(
        event: E,
        handler: (payload: EventPayload<E>) => void,
      ): void => {
        this.#eventBus.off(event, handler);
      },
    };
  }

  #buildCompletionPacket(
    binding: WorkerBinding,
    result: WorkerExecutionResult,
    startedAt: number,
  ): CompletionPacket {
    return {
      assignmentId: binding.assignmentId,
      runId: binding.runId,
      taskId: binding.taskId,
      status: result.status,
      artifacts: result.artifacts,
      filesTouched: result.filesTouched,
      toolsUsed: result.toolsUsed,
      tokensConsumed: result.tokensConsumed,
      durationMs: Date.now() - startedAt,
      turnCount: result.turnCount ?? 0,
      blocker: result.blocker,
      role: binding.role,
      completedAt: new Date().toISOString(),
    };
  }

  #emitCompletionPosted(packet: CompletionPacket): void {
    this.#eventBus.emit({
      event: "completion.posted",
      payload: {
        assignmentId: packet.assignmentId,
        runId: packet.runId,
        taskId: packet.taskId,
        status: packet.status,
        accepted: true,
      },
    });
  }

  async #postCompletion(packet: CompletionPacket): Promise<void> {
    if (this.#poster) {
      try {
        const postResult = await postStructuredCompletion(
          packet,
          this.#poster,
          this.#eventBus,
          this.#logger,
        );
        this.#logger.info("WorkerRuntime: completion posted to Den", {
          assignmentId: packet.assignmentId,
          runId: packet.runId,
          accepted: postResult.accepted,
        });
      } catch (err: unknown) {
        // postStructuredCompletion may throw on validation failure.
        // Emit the event ourselves and continue — the poster already
        // handles Den-unavailability internally (fail-closed).
        this.#logger.error("WorkerRuntime: completion post threw", {
          assignmentId: packet.assignmentId,
          runId: packet.runId,
          error: (err as Error).message,
        });
        this.#emitCompletionPosted(packet);
      }
    } else {
      this.#emitCompletionPosted(packet);
    }
  }

  #emitAssignmentReleased(binding: WorkerBinding, reason: string): void {
    this.#eventBus.emit({
      event: "assignment.released",
      payload: {
        assignmentId: Number(binding.assignmentId),
        workerIdentity: this.#config.workerIdentity,
        reason,
      },
    });
  }

  async #cleanupSession(session: SessionRecord): Promise<void> {
    await this.#sessionManager.archive(session.id);
    this.#logLifecycle("session_archived", null, {
      sessionId: session.id,
    });
  }

  #logLifecycle(
    phase: string,
    binding: WorkerBinding | null,
    extra?: Record<string, unknown>,
  ): void {
    this.#logger.debug(`WorkerRuntime: ${phase}`, {
      assignmentId: binding?.assignmentId ?? "N/A",
      runId: binding?.runId ?? "N/A",
      role: binding?.role ?? "N/A",
      ...extra,
    });
  }

  get workerIdentity(): string {
    return this.#config.workerIdentity;
  }

  /**
   * The injected worker role mapping used for profile resolution.
   * Exposed for test inspection — production code should use
   * {@link resolveProfileId} / {@link resolveRoleConfig} instead.
   */
  get roleMapping(): WorkerRoleMappingConfig {
    return this.#roleMapping;
  }
}
