/**
 * Idle timeout watchdog for WorkerRuntime — tracks worker activity
 * and emits worker.stuck evidence when idleTimeoutMs elapses without
 * a touch().
 *
 * Composes with diagnostics (#2050) and remediation (#2057) by
 * emitting structured stuck evidence through the EventBus without
 * silently releasing workflow state.
 *
 * @module pi-service/workers/worker-idle-timeout
 */

import type { EventBus, GatewayEvent } from "@pi-crew/core";
import type { SessionRecord, WorkerBinding } from "../sessions/types.js";
import type { WorkerRoleConfig } from "./worker-role-config.js";

/** Configuration for the idle timeout watchdog. */
export interface IdleTimeoutWatchdogConfig {
  readonly idleTimeoutMs: number;
  readonly eventBus: EventBus;
  readonly workerIdentity: string;
  readonly assignmentId: number;
  readonly runId: string;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly profileId?: string;
  readonly role?: string;
  /** Longer deadline for checkpoint_waiting state (ms). Default: idleTimeoutMs * 10. */
  readonly checkpointDeadlineMs?: number;
}

/**
 * Lifecycle state tracked by the watchdog.
 * Each touch() updates the last-activity timestamp and records the state.
 */
export type LifecycleState =
  | "executing"
  | "tool_calling"
  | "checkpoint_waiting"
  | "completing"
  | "released";

/** Runtime dependencies needed to create a WorkerRuntime idle watchdog. */
export interface WorkerIdleWatchdogRuntimeOptions {
  readonly eventBus: EventBus;
  readonly workerIdentity: string;
  readonly binding: WorkerBinding;
  readonly session: SessionRecord;
  readonly profileId: string;
  readonly roleConfig?: WorkerRoleConfig;
}

/**
 * Monitors worker activity and fires a one-shot "worker.stuck" event
 * when `idleTimeoutMs` passes without a touch().
 *
 * - touch() resets the idle deadline
 * - Once stuck fires, it does not fire again (no duplicate spam)
 * - checkpoint_waiting has its own longer deadline by default
 * - stop() cancels the timer and prevents emission
 * - Each touch/start records the lifecycle state for evidence
 */
export class IdleTimeoutWatchdog {
  readonly #idleTimeoutMs: number;
  readonly #checkpointDeadlineMs: number;
  readonly #eventBus: EventBus;
  readonly #workerIdentity: string;
  readonly #assignmentId: number;
  readonly #runId: string;
  readonly #taskId: string;
  readonly #sessionId: string | undefined;
  readonly #profileId: string | undefined;
  readonly #role: string | undefined;

  #timerId: ReturnType<typeof setTimeout> | undefined;
  #lastActivityAt: number = 0;
  #lastState: LifecycleState | undefined;
  #hasFired: boolean = false;

  constructor(config: IdleTimeoutWatchdogConfig) {
    this.#idleTimeoutMs = config.idleTimeoutMs;
    this.#checkpointDeadlineMs =
      config.checkpointDeadlineMs ?? config.idleTimeoutMs * 10;
    this.#eventBus = config.eventBus;
    this.#workerIdentity = config.workerIdentity;
    this.#assignmentId = config.assignmentId;
    this.#runId = config.runId;
    this.#taskId = config.taskId;
    this.#sessionId = config.sessionId;
    this.#profileId = config.profileId;
    this.#role = config.role;
  }

  /** Start the watchdog with an initial lifecycle state. */
  start(state: LifecycleState): void {
    this.#lastState = state;
    this.#lastActivityAt = Date.now();
    this.#hasFired = false;
    this.#schedule();
  }

  /** Record activity and reset the idle deadline. */
  touch(state: LifecycleState): void {
    this.#lastState = state;
    this.#lastActivityAt = Date.now();
    this.#hasFired = false;
    this.#clearTimer();
    this.#schedule();
  }

  /** Cancel the timer. No further stuck events will be emitted. */
  stop(): void {
    this.#clearTimer();
  }

  /** Record activity represented by a typed gateway event. */
  touchForEvent(event: GatewayEvent): void {
    const state = lifecycleStateForEvent(event);
    if (state === "released") {
      this.touch(state);
      this.stop();
      return;
    }
    if (state !== undefined) {
      this.touch(state);
    }
  }

  // ── Private ──────────────────────────────────────────────────

  #schedule(): void {
    const deadlineMs =
      this.#lastState === "checkpoint_waiting"
        ? this.#checkpointDeadlineMs
        : this.#idleTimeoutMs;

    this.#timerId = setTimeout(() => {
      this.#fire();
    }, deadlineMs);
  }

  #fire(): void {
    if (this.#hasFired) return;
    this.#hasFired = true;

    this.#eventBus.emit({
      event: "worker.stuck",
      payload: {
        workerIdentity: this.#workerIdentity,
        assignmentId: this.#assignmentId,
        runId: this.#runId,
        taskId: this.#taskId,
        sessionId: this.#sessionId,
        profileId: this.#profileId,
        role: this.#role,
        lastActivityAt: new Date(this.#lastActivityAt).toISOString(),
        lastLifecycleState: this.#lastState ?? "executing",
        idleTimeoutMs: this.#idleTimeoutMs,
        remediationRequired: true,
        reason:
          `Worker ${this.#workerIdentity} (assignment ${String(this.#assignmentId)}) ` +
          `idle for ${String(this.#idleTimeoutMs)}ms ` +
          `in state "${this.#lastState ?? "executing"}"`,
      },
    });
  }

  #clearTimer(): void {
    if (this.#timerId !== undefined) {
      clearTimeout(this.#timerId);
      this.#timerId = undefined;
    }
  }
}

/** Create the per-assignment watchdog when WorkerPolicy defines idleTimeoutMs. */
export function createWorkerIdleWatchdog(
  options: WorkerIdleWatchdogRuntimeOptions,
): IdleTimeoutWatchdog | undefined {
  const idleTimeoutMs = options.roleConfig?.toolPolicyDefaults?.idleTimeoutMs;
  if (idleTimeoutMs === undefined) {
    return undefined;
  }
  return new IdleTimeoutWatchdog({
    idleTimeoutMs,
    eventBus: options.eventBus,
    workerIdentity: options.workerIdentity,
    assignmentId: Number(options.binding.assignmentId),
    runId: options.binding.runId,
    taskId: options.binding.taskId,
    sessionId: options.session.id,
    profileId: options.profileId,
    role: options.binding.role,
  });
}

function lifecycleStateForEvent(
  event: GatewayEvent,
): LifecycleState | undefined {
  switch (event.event) {
    case "turn.started":
    case "turn.completed":
    case "turn.errored":
    case "turn.exhausted":
      return "executing";
    case "tool.called":
    case "tool.completed":
      return "tool_calling";
    case "checkpoint.waiting":
      return "checkpoint_waiting";
    case "completion.posted":
      return "completing";
    case "assignment.released":
      return "released";
    default:
      return undefined;
  }
}
