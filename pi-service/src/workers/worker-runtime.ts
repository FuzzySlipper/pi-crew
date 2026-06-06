/**
 * WorkerRuntime — drives the Den worker claim→execute→complete→release lifecycle.
 *
 * Orchestrates the full worker assignment contract defined in
 * `den-worker-runtime-contract`. Every lifecycle transition emits
 * a typed event on the gateway EventBus with Den correlation IDs.
 *
 * The runtime is injected with a worker executor (the actual worker
 * logic) so it remains role-agnostic. The packet-auditor is one such
 * executor.
 *
 * @module pi-service/workers/worker-runtime
 */

import type {
  Logger,
  EventBus,
  CompletionPacket,
  CompletionStatus,
  GatewayEvent,
} from "@pi-crew/core";
import type { SessionManager } from "../sessions/session-manager.js";
import type { InstancePool } from "../instances/instance-pool.js";
import type {
  SessionConfig,
  WorkerBinding,
  SessionRecord,
} from "../sessions/types.js";
import type { AuditRepository } from "../persistence/types.js";

// ── Worker executor contract ──────────────────────────────────

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
  /** Emit an event on the gateway bus. */
  emitEvent(event: GatewayEvent): void;
  /** Log a message with the worker's correlation context. */
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
  /** Write an audit event with auto-filled correlation IDs. */
  writeAudit(eventType: string, data: Record<string, unknown>): Promise<void>;
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
  /** Execution summary for the completion packet. */
  readonly summary: string;
  /** Blocker details (only when status is "blocked" or "failed"). */
  readonly blocker?: {
    readonly reason: string;
    readonly requires: "human" | "dependency" | "review";
    readonly details: string;
  };
}

// ── WorkerRuntime config ──────────────────────────────────────

/** Configuration for {@link WorkerRuntime}. */
export interface WorkerRuntimeConfig {
  /** Identity of this runtime instance. */
  readonly workerIdentity: string;
}

// ── WorkerRuntime ─────────────────────────────────────────────

/**
 * Drives the Den worker lifecycle for a single assignment.
 *
 * 1. Claims the assignment (emits assignment.claimed).
 * 2. Creates a fresh worker session with WorkerBinding.
 * 3. Executes the worker logic via the injected executor.
 * 4. Posts a structured CompletionPacket.
 * 5. Releases the assignment (emits assignment.released).
 * 6. Archives the worker session.
 */
export class WorkerRuntime {
  readonly #config: WorkerRuntimeConfig;
  readonly #sessionManager: SessionManager;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #auditRepo: AuditRepository;

  constructor(
    config: WorkerRuntimeConfig,
    sessionManager: SessionManager,
    pool: InstancePool,
    eventBus: EventBus,
    logger: Logger,
    auditRepo: AuditRepository,
  ) {
    void pool; // retained for future policy checks, kept in signature for composition
    this.#config = config;
    this.#sessionManager = sessionManager;
    this.#eventBus = eventBus;
    this.#logger = logger;
    this.#auditRepo = auditRepo;
  }

  /**
   * Execute the full worker lifecycle for an assignment.
   */
  async executeAssignment(
    binding: WorkerBinding,
    executor: WorkerExecutor,
  ): Promise<CompletionPacket> {
    const startedAt = Date.now();
    const profileId = this.#resolveProfileId(binding.role);

    // ── Phase 1: Claim ──────────────────────────────────────
    this.#logLifecycle("claiming", binding);
    this.#emitAssignmentClaimed(binding);

    // ── Phase 2: Create worker session ──────────────────────
    const session = await this.#createWorkerSession(binding, profileId);
    this.#logLifecycle("session_created", binding, { sessionId: session.id });

    // ── Phase 3: Execute worker logic ───────────────────────
    this.#emitTurnStarted(session.id, 1);

    const context = this.#buildContext(binding, session);
    let result: WorkerExecutionResult;

    try {
      result = await executor.execute(context);
    } catch (error: unknown) {
      const errMsg = (error as Error).message;
      this.#logLifecycle("execution_failed", binding, { error: errMsg });
      result = {
        status: "failed",
        artifacts: [],
        filesTouched: [],
        toolsUsed: [],
        tokensConsumed: 0,
        summary: `Worker execution failed: ${errMsg}`,
        blocker: {
          reason: errMsg,
          requires: "human",
          details: (error as Error).stack ?? errMsg,
        },
      };
    }

    this.#emitTurnCompleted(session.id, 1, Date.now() - startedAt);

    // ── Phase 4: Build and emit completion packet ───────────
    const packet = this.#buildCompletionPacket(binding, result, startedAt);
    this.#emitCompletionPosted(packet);

    // ── Phase 5: Release ────────────────────────────────────
    const releaseReason =
      packet.status === "completed" ? "completed" : "failed";
    this.#emitAssignmentReleased(binding, releaseReason);

    // ── Phase 6: Archive session, release instance ──────────
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

  // ── Internal: claim ──────────────────────────────────────────

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

  // ── Internal: session management ─────────────────────────────

  async #createWorkerSession(
    binding: WorkerBinding,
    profileId: string,
  ): Promise<SessionRecord> {
    const config: SessionConfig = {
      profileId,
      kind: "worker",
      channelBindings: [],
      workerBinding: binding,
    };

    return this.#sessionManager.create(config);
  }

  // ── Internal: execution context ──────────────────────────────

  #buildContext(
    binding: WorkerBinding,
    session: SessionRecord,
  ): WorkerExecutionContext {
    return {
      binding,
      session,
      emitEvent: (event: GatewayEvent): void => {
        this.#eventBus.emit(event);
      },
      log: (
        level: "debug" | "info" | "warn" | "error",
        message: string,
      ): void => {
        this.#logger[level](`[worker] ${message}`, {
          assignmentId: binding.assignmentId,
          runId: binding.runId,
          sessionId: session.id,
        });
      },
      writeAudit: async (
        eventType: string,
        data: Record<string, unknown>,
      ): Promise<void> => {
        await this.#auditRepo.write({
          sessionId: session.id,
          assignmentId: binding.assignmentId,
          runId: binding.runId,
          eventType,
          eventData: data,
        });
      },
    };
  }

  // ── Internal: completion packet ──────────────────────────────

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
      turnCount: 1,
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

  // ── Internal: release ────────────────────────────────────────

  #emitAssignmentReleased(
    binding: WorkerBinding,
    reason: string,
  ): void {
    this.#eventBus.emit({
      event: "assignment.released",
      payload: {
        assignmentId: Number(binding.assignmentId),
        workerIdentity: this.#config.workerIdentity,
        reason,
      },
    });
  }

  // ── Internal: cleanup ────────────────────────────────────────

  async #cleanupSession(session: SessionRecord): Promise<void> {
    await this.#sessionManager.archive(session.id);
    this.#logLifecycle("session_archived", null, {
      sessionId: session.id,
    });
  }

  // ── Internal: lifecycle events (turn) ────────────────────────

  #emitTurnStarted(sessionId: string, turnNumber: number): void {
    this.#eventBus.emit({
      event: "turn.started",
      payload: { sessionId, turnNumber },
    });
  }

  #emitTurnCompleted(
    sessionId: string,
    turnNumber: number,
    durationMs: number,
  ): void {
    this.#eventBus.emit({
      event: "turn.completed",
      payload: { sessionId, turnNumber, durationMs },
    });
  }

  // ── Internal: helpers ────────────────────────────────────────

  #resolveProfileId(role: string): string {
    switch (role) {
      case "packet-auditor":
        return "packet-auditor";
      case "coder":
        return "spawned-coder";
      case "reviewer":
        return "spawned-reviewer";
      case "validator":
        return "spawned-validator";
      default:
        return `worker-${role}`;
    }
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

  // ── Accessors ──────────────────────────────────────────────

  get workerIdentity(): string {
    return this.#config.workerIdentity;
  }
}
