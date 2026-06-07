/** Timeout enforcement helpers for WorkerRuntime. */

import type {
  CompletionPacket,
  EventBus,
  GatewayEvent,
} from "@pi-crew/core";
import type {
  SessionRecord,
  WorkerBinding,
} from "../sessions/types.js";
import type { WorkerRoleConfig } from "./worker-role-config.js";
import type {
  WorkerExecutionContext,
  WorkerExecutionResult,
  WorkerExecutor,
} from "./worker-runtime.js";

/** Default assignment duration timeout (30 minutes). */
export const DEFAULT_ASSIGNMENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Default per-turn timeout (5 minutes). */
export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

export interface TimeoutExecutionOptions {
  readonly executor: WorkerExecutor;
  readonly context: WorkerExecutionContext;
  readonly binding: WorkerBinding;
  readonly session: SessionRecord;
  readonly profileId: string;
  readonly roleConfig?: WorkerRoleConfig;
  readonly startedAt: number;
  readonly eventBus: EventBus;
  logLifecycle(
    phase: string,
    binding: WorkerBinding | null,
    extra?: Record<string, unknown>,
  ): void;
}

export async function executeWithAssignmentTimeout(
  options: TimeoutExecutionOptions,
): Promise<WorkerExecutionResult> {
  const assignmentTimeoutMs =
    options.roleConfig?.toolPolicyDefaults?.assignmentTimeoutMs ??
    DEFAULT_ASSIGNMENT_TIMEOUT_MS;
  const turnTimeoutMs =
    options.roleConfig?.toolPolicyDefaults?.idleTimeoutMs ??
    DEFAULT_TURN_TIMEOUT_MS;
  const abort = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      abort.abort();
      reject(
        new AssignmentTimeoutError(
          options.binding,
          options.session.id,
          options.profileId,
          assignmentTimeoutMs,
          Date.now() - options.startedAt,
        ),
      );
    }, assignmentTimeoutMs);
  });

  try {
    const result = await Promise.race([
      options.executor.execute(withSignal(options.context, abort.signal)),
      timeoutPromise,
    ]);
    emitTurnCompleted(options, Date.now() - options.startedAt);
    return result;
  } catch (error: unknown) {
    if (error instanceof AssignmentTimeoutError) {
      return handleAssignmentTimeout(
        options,
        error,
        assignmentTimeoutMs,
        turnTimeoutMs,
        abort,
      );
    }
    return handleExecutionError(options, error);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function withSignal(
  context: WorkerExecutionContext,
  signal: AbortSignal,
): WorkerExecutionContext {
  return { ...context, signal };
}

function handleAssignmentTimeout(
  options: TimeoutExecutionOptions,
  error: AssignmentTimeoutError,
  assignmentTimeoutMs: number,
  turnTimeoutMs: number,
  abort: AbortController,
): WorkerExecutionResult {
  const elapsedMs = Math.max(
    Date.now() - options.startedAt,
    assignmentTimeoutMs,
  );
  options.logLifecycle("assignment_timed_out", options.binding, {
    sessionId: options.session.id,
    timeoutMs: assignmentTimeoutMs,
    elapsedMs,
    profileId: options.profileId,
  });
  emitTurnCompleted(options, elapsedMs);
  emitAssignmentTimedOut(options, assignmentTimeoutMs, elapsedMs);

  const packet = buildTimeoutPacket(
    options.binding,
    options.session.id,
    options.profileId,
    elapsedMs,
    assignmentTimeoutMs,
  );
  abort.abort();

  return {
    status: "failed",
    artifacts: packet.artifacts,
    filesTouched: [],
    toolsUsed: [],
    tokensConsumed: 0,
    summary:
      `Assignment timed out after ${String(elapsedMs)}ms ` +
      `(limit: ${String(assignmentTimeoutMs)}ms)`,
    releaseReason: "timeout",
    blocker: {
      reason: error.message,
      requires: "human",
      details: JSON.stringify({
        assignmentId: options.binding.assignmentId,
        runId: options.binding.runId,
        taskId: options.binding.taskId,
        sessionId: options.session.id,
        profileId: options.profileId,
        role: options.binding.role,
        assignmentTimeoutMs,
        timeoutMs: assignmentTimeoutMs,
        turnTimeoutMs,
        elapsedMs,
      }),
    },
  };
}

function handleExecutionError(
  options: TimeoutExecutionOptions,
  error: unknown,
): WorkerExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  emitTurnCompleted(options, Date.now() - options.startedAt);
  options.logLifecycle("execution_failed", options.binding, { error: message });
  return {
    status: "failed",
    artifacts: [],
    filesTouched: [],
    toolsUsed: [],
    tokensConsumed: 0,
    summary: `Worker execution failed: ${message}`,
    blocker: {
      reason: message,
      requires: "human",
      details: stack ?? message,
    },
  };
}

function buildTimeoutPacket(
  binding: WorkerBinding,
  sessionId: string,
  profileId: string,
  elapsedMs: number,
  timeoutMs: number,
): CompletionPacket {
  const details = JSON.stringify({
    assignmentId: binding.assignmentId,
    runId: binding.runId,
    taskId: binding.taskId,
    sessionId,
    profileId,
    role: binding.role,
    timeoutMs,
    elapsedMs,
  });
  return {
    assignmentId: binding.assignmentId,
    runId: binding.runId,
    taskId: binding.taskId,
    status: "failed",
    artifacts: [
      {
        type: "timeout_evidence",
        ref: `run:${binding.runId}`,
        summary:
          `Assignment timed out: ${String(elapsedMs)}ms elapsed ` +
          `(limit: ${String(timeoutMs)}ms) — ` +
          `session=${sessionId}, profile=${profileId}`,
      },
    ],
    filesTouched: [],
    toolsUsed: [],
    tokensConsumed: 0,
    durationMs: elapsedMs,
    turnCount: 1,
    blocker: {
      reason: `Assignment exceeded ${String(timeoutMs)}ms timeout`,
      requires: "human",
      details,
    },
    role: binding.role,
    completedAt: new Date().toISOString(),
  };
}

function emitTurnCompleted(
  options: TimeoutExecutionOptions,
  durationMs: number,
): void {
  options.eventBus.emit({
    event: "turn.completed",
    payload: {
      sessionId: options.session.id,
      turnNumber: 1,
      durationMs,
    },
  });
}

function emitAssignmentTimedOut(
  options: TimeoutExecutionOptions,
  timeoutMs: number,
  elapsedMs: number,
): void {
  const event: GatewayEvent = {
    event: "assignment.timed_out",
    payload: {
      assignmentId: Number(options.binding.assignmentId),
      runId: options.binding.runId,
      taskId: options.binding.taskId,
      sessionId: options.session.id,
      profileId: options.profileId,
      role: options.binding.role,
      timeoutMs,
      elapsedMs,
      reason:
        `Assignment exceeded ${String(timeoutMs)}ms timeout ` +
        `(elapsed: ${String(elapsedMs)}ms)`,
    },
  };
  options.eventBus.emit(event);
}

export class AssignmentTimeoutError extends Error {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly role: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;

  constructor(
    binding: WorkerBinding,
    sessionId: string,
    profileId: string,
    timeoutMs: number,
    elapsedMs: number,
  ) {
    super(
      `Assignment ${binding.assignmentId} (run ${binding.runId}) ` +
        `timed out after ${String(elapsedMs)}ms ` +
        `(limit: ${String(timeoutMs)}ms)`,
    );
    this.name = "AssignmentTimeoutError";
    this.assignmentId = binding.assignmentId;
    this.runId = binding.runId;
    this.taskId = binding.taskId;
    this.sessionId = sessionId;
    this.profileId = profileId;
    this.role = binding.role;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}
