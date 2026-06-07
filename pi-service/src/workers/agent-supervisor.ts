/**
 * AgentSupervisor — bridges pi-agent-core Agent events into typed
 * pi-crew GatewayEvents with Den correlation IDs.
 *
 * Wraps an upstream {@link Agent} and subscribes to its event stream,
 * mapping every lifecycle event (start, turn, tool, end) to a typed
 * GatewayEvent on the shared EventBus.  Correlation context
 * (assignmentId, runId, taskId, sessionId, profileId) is attached to
 * every emitted event and lifecycle log entry.
 *
 * This component does NOT enforce policy, guard tools, or manage
 * drain/checkpoint state.  Those concerns belong to separate
 * components (WorkerPolicy, guarded tool wrappers, drain manager).
 *
 * @module pi-service/workers/agent-supervisor
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { EventBus, Logger } from "@pi-crew/core";
import type { WorkerBinding } from "../sessions/types.js";

// ── AgentLike: testable subset of Agent's public API ─────────────

/**
 * Minimal interface representing the Agent subscription surface
 * needed by AgentSupervisor.  The real {@link PiAgent} satisfies
 * this interface; test fakes implement it to emit controlled event
 * streams.
 */
export interface AgentLike {
  /**
   * Subscribe to Agent lifecycle events.
   *
   * Returns an unsubscribe function.  Listeners are called in
   * subscription order and are awaited before the next event.
   */
  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void;
}

// ── Config ───────────────────────────────────────────────────────

/**
 * Configuration for {@link AgentSupervisor}.
 *
 * Carries the Den correlation context and the runtime dependencies
 * needed to emit typed GatewayEvents and lifecycle logs.
 */
export interface AgentSupervisorConfig {
  /** Den assignment binding with correlation IDs. */
  readonly binding: WorkerBinding;
  /** Worker session ID for this assignment. */
  readonly sessionId: string;
  /** Resolved profile ID for this worker role. */
  readonly profileId: string;
  /** Shared EventBus for emitting GatewayEvents. */
  readonly eventBus: EventBus;
  /** Logger for lifecycle telemetry (info/debug only). */
  readonly logger: Logger;
}

// ── AgentSupervisor ──────────────────────────────────────────────

/**
 * Bridges pi-agent-core Agent events into typed pi-crew GatewayEvents
 * with full Den correlation IDs.
 *
 * ## Lifecycle mapping
 *
 * | Agent event               | GatewayEvent      | Notes                        |
 * |---------------------------|-------------------|------------------------------|
 * | `agent_start`             | —                 | Logged; runtime owns start evidence |
 * | `turn_start`              | `turn.started`    | Increments turn counter      |
 * | `tool_execution_start`    | `tool.called`     | With tool name + sessionId   |
 * | `tool_execution_end`      | `tool.completed`  | With success + duration      |
 * | `turn_end`                | `turn.completed`  | With turn number + duration  |
 * | `agent_end`               | —                 | Logged; completion is WorkerRuntime's job |
 *
 * Every lifecycle log entry includes:
 * `assignmentId`, `runId`, `taskId`, `sessionId`, `profileId`.
 *
 * ## Usage
 *
 * ```ts
 * const supervisor = new AgentSupervisor(config, agent);
 * supervisor.start();
 * // ... agent.prompt(...) / agent.waitForIdle() ...
 * supervisor.stop();
 * ```
 */
export class AgentSupervisor {
  readonly #binding: WorkerBinding;
  readonly #sessionId: string;
  readonly #profileId: string;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #agent: AgentLike;

  #turnCount = 0;
  #turnStartTime = 0;
  #toolStartTimes = new Map<string, number>();
  #unsubscribe: (() => void) | null = null;

  constructor(config: AgentSupervisorConfig, agent: AgentLike) {
    this.#binding = config.binding;
    this.#sessionId = config.sessionId;
    this.#profileId = config.profileId;
    this.#eventBus = config.eventBus;
    this.#logger = config.logger;
    this.#agent = agent;
  }

  // ── Public API ───────────────────────────────────────────────

  /** Start listening to Agent events. Idempotent. */
  start(): void {
    if (this.#unsubscribe !== null) return;
    this.#unsubscribe = this.#agent.subscribe((event) => {
      this.#handleEvent(event);
    });
  }

  /** Stop listening. Idempotent — safe to call multiple times. */
  stop(): void {
    if (this.#unsubscribe === null) return;
    this.#unsubscribe();
    this.#unsubscribe = null;
  }

  /** Current turn count (1-based). Zero before agent_start. */
  get turnCount(): number {
    return this.#turnCount;
  }

  // ── Event handler ────────────────────────────────────────────

  #handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.#onAgentStart();
        break;
      case "turn_start":
        this.#onTurnStart();
        break;
      case "tool_execution_start":
        this.#onToolStart(event);
        break;
      case "tool_execution_end":
        this.#onToolEnd(event);
        break;
      case "turn_end":
        this.#onTurnEnd();
        break;
      case "agent_end":
        this.#onAgentEnd(event);
        break;
    }
  }

  // ── Per-event handlers ───────────────────────────────────────

  #onAgentStart(): void {
    this.#turnCount = 0;
    this.#logger.info("AgentSupervisor: agent.start", this.#correlationCtx());
  }

  #onTurnStart(): void {
    this.#turnCount++;
    this.#turnStartTime = Date.now();
    this.#eventBus.emit({
      event: "turn.started",
      payload: {
        ...this.#eventCorrelationCtx(),
        sessionId: this.#sessionId,
        turnNumber: this.#turnCount,
      },
    });
  }

  #onToolStart(event: AgentEvent & { type: "tool_execution_start" }): void {
    this.#toolStartTimes.set(event.toolCallId, Date.now());
    this.#logger.info("AgentSupervisor: tool.start", {
      ...this.#correlationCtx(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
    this.#eventBus.emit({
      event: "tool.called",
      payload: {
        ...this.#eventCorrelationCtx(),
        toolName: event.toolName,
        sessionId: this.#sessionId,
      },
    });
  }

  #onToolEnd(event: AgentEvent & { type: "tool_execution_end" }): void {
    const startTime = this.#toolStartTimes.get(event.toolCallId);
    const durationMs =
      startTime !== undefined ? Date.now() - startTime : 0;
    this.#toolStartTimes.delete(event.toolCallId);

    this.#logger.info("AgentSupervisor: tool.end", {
      ...this.#correlationCtx(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      durationMs,
    });
    this.#eventBus.emit({
      event: "tool.completed",
      payload: {
        ...this.#eventCorrelationCtx(),
        toolName: event.toolName,
        sessionId: this.#sessionId,
        success: !event.isError,
        durationMs,
      },
    });
  }

  #onTurnEnd(): void {
    const durationMs =
      this.#turnStartTime > 0 ? Date.now() - this.#turnStartTime : 0;
    this.#logger.info("AgentSupervisor: turn.end", {
      ...this.#correlationCtx(),
      turnNumber: this.#turnCount,
      durationMs,
    });
    this.#eventBus.emit({
      event: "turn.completed",
      payload: {
        ...this.#eventCorrelationCtx(),
        sessionId: this.#sessionId,
        turnNumber: this.#turnCount,
        durationMs,
      },
    });
  }

  #onAgentEnd(event: AgentEvent & { type: "agent_end" }): void {
    this.#logger.info("AgentSupervisor: agent.end", {
      ...this.#correlationCtx(),
      turnCount: this.#turnCount,
      messageCount: event.messages.length,
    });
  }

  // ── Helpers ─────────────────────────────────────────────────

  #correlationCtx(): Record<string, string | number | undefined> {
    return {
      assignmentId: this.#binding.assignmentId,
      runId: this.#binding.runId,
      taskId: this.#binding.taskId,
      sessionId: this.#sessionId,
      profileId: this.#profileId,
    };
  }

  #eventCorrelationCtx(): {
    assignmentId: string;
    runId: string;
    taskId: string;
    profileId: string;
  } {
    return {
      assignmentId: this.#binding.assignmentId,
      runId: this.#binding.runId,
      taskId: this.#binding.taskId,
      profileId: this.#profileId,
    };
  }
}
