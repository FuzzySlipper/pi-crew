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
 * ## Token tracking
 *
 * When a {@link ContextUsageTracker} is provided via config, the
 * supervisor accumulates real token-usage data from pi-agent-core
 * `message_end` events (assistant messages carry `usage.totalTokens`).
 * After each turn, it emits `context.pressure` events at 70%/85%/95%
 * threshold crossings via a {@link TokenPressureEmitter}.
 *
 * @module pi-service/workers/agent-supervisor
 */

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { EventBus, Logger } from "@pi-crew/core";
import type { ContextUsageTracker, DrainModeManager } from "@pi-crew/tools";
import { TokenPressureEmitter } from "@pi-crew/tools";
import type { WorkerBinding } from "../sessions/types.js";

// ── AgentLike: testable subset of Agent's public API ─────────────

/**
 * Minimal interface representing the Agent subscription surface
 * needed by AgentSupervisor.  The real {@link PiAgent} satisfies
 * this interface; test fakes implement it to emit controlled event
 * streams.
 */
export interface AgentLike {
  /** Mutable Agent state used by pi-agent-core for its active tool surface. */
  readonly state?: {
    tools: AgentToolRef[];
  };
  /**
   * Subscribe to Agent lifecycle events.
   *
   * Returns an unsubscribe function.  Listeners are called in
   * subscription order and are awaited before the next event.
   */
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
}

/**
 * Extends {@link AgentLike} with queueing methods for mid-run
 * steering and follow-up via Den Channels direct-agent events.
 *
 * The real pi-agent-core {@link Agent} satisfies this interface
 * through its {@code steer()} and {@code followUp()} methods.
 */
export interface SteerableAgent extends AgentLike {
  /** Queue a message to be injected after the current assistant turn finishes. */
  steer(message: AgentMessage): void;
  /** Queue a message to run only after the agent would otherwise stop. */
  followUp(message: AgentMessage): void;
  /** True when either steering or follow-up queue still has pending messages. */
  hasQueuedMessages(): boolean;
}

/** Minimal tool shape needed to reduce `agent.state.tools` in drain mode. */
export interface AgentToolRef {
  readonly name: string;
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
  /**
   * Optional token-usage tracker.
   *
   * When provided, the supervisor accumulates real pi-agent-core
   * token data from `message_end` events and checks pressure
   * thresholds after each turn.
   */
  readonly tokenTracker?: ContextUsageTracker;
  /** Optional shared pressure emitter for session-wide deduplication. */
  readonly pressureEmitter?: TokenPressureEmitter;
  /** Optional drain-mode manager used to shrink the real Agent tool surface. */
  readonly drainManager?: DrainModeManager;
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
 * | `message_end` (assistant) | —                 | Accumulates token usage        |
 * | `turn_end`                | `turn.completed`  | With turn number + duration; checks pressure |
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
  readonly #tokenTracker: ContextUsageTracker | undefined;
  readonly #pressureEmitter: TokenPressureEmitter | undefined;
  readonly #drainManager: DrainModeManager | undefined;

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
    this.#tokenTracker = config.tokenTracker;
    this.#pressureEmitter = config.tokenTracker
      ? (config.pressureEmitter ?? new TokenPressureEmitter())
      : undefined;
    this.#drainManager = config.drainManager;
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

  /**
   * Estimated tokens used across all turns.
   *
   * Returns 0 when no token tracker is configured.
   */
  get tokensUsed(): number {
    return this.#tokenTracker?.tokensUsed ?? 0;
  }

  /**
   * The token-usage tracker for this session, or undefined when
   * token tracking is not configured.
   */
  get tokenTracker(): ContextUsageTracker | undefined {
    return this.#tokenTracker;
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
      case "message_end":
        this.#onMessageEnd(event);
        break;
      case "turn_end":
        this.#onTurnEnd();
        break;
      case "agent_end":
        this.#onAgentEnd(event);
        break;
      default:
        // message_start, message_update, tool_execution_update
        // are streaming noise — no action needed.
        break;
    }
  }

  // ── Per-event handlers ───────────────────────────────────────

  #onAgentStart(): void {
    this.#turnCount = 0;
    this.#pressureEmitter?.reset();
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
    const durationMs = startTime !== undefined ? Date.now() - startTime : 0;
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

  /**
   * Accumulate token usage from assistant message_end events.
   *
   * pi-agent-core's Agent emits `message_end` with `message: AgentMessage`.
   * For assistant messages, `message.usage.totalTokens` carries the
   * cost of the model response.  We accumulate this into the token
   * tracker for context_status and drain-mode decisions.
   */
  #onMessageEnd(event: AgentEvent & { type: "message_end" }): void {
    if (
      this.#tokenTracker &&
      "role" in event.message &&
      event.message.role === "assistant" &&
      "usage" in event.message
    ) {
      const usage = (event.message as { usage: { totalTokens: number } }).usage;
      this.#tokenTracker.accumulate({ tokensUsed: usage.totalTokens });
    }
  }

  #onTurnEnd(): void {
    const durationMs = this.#turnStartTime > 0 ? Date.now() - this.#turnStartTime : 0;
    this.#logger.info("AgentSupervisor: turn.end", {
      ...this.#correlationCtx(),
      turnNumber: this.#turnCount,
      durationMs,
      tokensUsed: this.#tokenTracker?.tokensUsed,
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

    // Check pressure thresholds after every turn
    if (this.#tokenTracker && this.#pressureEmitter) {
      this.#pressureEmitter.checkAndEmit(
        this.#tokenTracker,
        this.#sessionId,
        this.#eventBus,
        this.#logger,
      );
    }

    if (this.#tokenTracker && this.#drainManager?.autoActivateForTokens(this.#tokenTracker)) {
      this.#applyDrainTools();
    }
  }

  #applyDrainTools(): void {
    const state = this.#agent.state;
    if (!state || !this.#drainManager) return;

    const before = state.tools;
    const allowedNames = new Set(
      this.#drainManager.filterForDrain(before.map((tool) => tool.name)),
    );
    const after = before.filter((tool) => allowedNames.has(tool.name));
    if (after.length === before.length) return;

    state.tools = after;
    this.#logger.warn("AgentSupervisor: applied drain tool filter", {
      ...this.#correlationCtx(),
      before: before.length,
      after: after.length,
    });
  }

  #onAgentEnd(event: AgentEvent & { type: "agent_end" }): void {
    this.#logger.info("AgentSupervisor: agent.end", {
      ...this.#correlationCtx(),
      turnCount: this.#turnCount,
      messageCount: event.messages.length,
      tokensUsed: this.#tokenTracker?.tokensUsed,
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
