import type {
  DelegationCompletedPayload,
  DelegationKilledPayload,
  DelegationOrphanDetectedPayload,
  DelegationSpawnedPayload,
  DelegationTimeoutPayload,
  DelegationToolVisiblePayload,
  DelegationTurnVisiblePayload,
  EventPayload,
  Logger,
} from "@pi-crew/core";
import type { ServiceExtension, ServiceExtensionContext } from "../extension-activator.js";
import {
  projectDelegationMessageToChannel,
  type DelegationChannelProjectionConfig,
} from "./den-delegation-channel-projection.js";

// ── Rate limiting configuration ──────────────────────────────────

/**
 * Minimum interval (ms) between Channel projections for
 * high-frequency events (turn_visible, tool_visible).
 *
 * DESIGN: turn_visible and tool_visible events can fire multiple times
 * per child execution. Projecting every one to Den Channels would flood
 * the channel. We coalesce them within the cooldown window and emit
 * a compact summary instead.
 *
 * High-signal events (spawned, completed, killed, timeout, orphan_detected)
 * are always projected immediately (no rate limit).
 */
const DEFAULT_TURN_COOLDOWN_MS = 5_000;
const DEFAULT_TOOL_COOLDOWN_MS = 5_000;

/**
 * Whether tool_visible events with phase "called" are projected to
 * Den Channels. "completed" phase tool events are higher signal.
 */
const PROJECT_TOOL_CALLED_EVENTS = false;

// ── Event signal tiers ───────────────────────────────────────────

/**
 * Signal tier for delegation events.
 *
 * HIGH: always project to Den surface immediately.
 * MEDIUM: project to Den surface, but rate-limited.
 * LOW: log only (never project to Den surface).
 */
type EventSignalTier = "high" | "medium" | "low";

interface EventProjectionConfig {
  readonly tier: EventSignalTier;
  readonly cooldownMs?: number;
}

function eventProjectionConfig(eventName: string): EventProjectionConfig {
  switch (eventName) {
    // High-signal lifecycle milestones — always project immediately
    case "delegation.spawned":
    case "delegation.completed":
    case "delegation.killed":
    case "delegation.timeout":
    case "delegation.orphan_detected":
      return { tier: "high" };

    // Medium-signal — project but rate-limited
    case "delegation.turn_visible":
      return { tier: "medium", cooldownMs: DEFAULT_TURN_COOLDOWN_MS };

    case "delegation.tool_visible":
      return { tier: "medium", cooldownMs: DEFAULT_TOOL_COOLDOWN_MS };

    // Unknown — treat as low (log only)
    default:
      return { tier: "low" };
  }
}

// ── Coalescing state ─────────────────────────────────────────────

interface CoalescedTurnState {
  readonly childSessionId: string;
  turnCount: number;
  lastPhase: string;
  lastSeenAt: number;
  lastProjectedAt: number;
}

interface CoalescedToolState {
  readonly childSessionId: string;
  toolCallCount: number;
  completedCount: number;
  deniedCount: number;
  lastSeenAt: number;
  lastProjectedAt: number;
}

// ── Event formatters ─────────────────────────────────────────────

interface ProjectedMessage {
  readonly eventName: string;
  readonly summary: string;
  readonly details: Record<string, unknown>;
}

function formatSpawnedMessage(payload: DelegationSpawnedPayload): ProjectedMessage {
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

function formatCompletedMessage(payload: DelegationCompletedPayload): ProjectedMessage {
  return {
    eventName: "delegation.completed",
    summary: `Subagent completed: ${payload.result.outcome} — ${payload.result.summary.slice(0, 200)}`,
    details: {
      childSessionId: payload.childSessionId,
      outcome: payload.result.outcome,
      failureCategory: payload.result.failureCategory,
      tokensConsumed: payload.result.tokensConsumed,
      turnsUsed: payload.result.turnsUsed,
      durationMs: payload.result.durationMs,
      error: payload.result.error,
      recoveryGuidance: payload.result.recoveryGuidance,
      evidenceChecked: payload.result.evidenceChecked,
      artifactCount: payload.result.artifacts?.length ?? 0,
    },
  };
}

function formatKilledMessage(payload: DelegationKilledPayload): ProjectedMessage {
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

function formatTimeoutMessage(payload: DelegationTimeoutPayload): ProjectedMessage {
  return {
    eventName: "delegation.timeout",
    summary: `Subagent timed out: ${payload.elapsedMs}ms elapsed, ${payload.timeoutMs}ms limit`,
    details: {
      childSessionId: payload.childSessionId,
      timeoutMs: payload.timeoutMs,
      elapsedMs: payload.elapsedMs,
    },
  };
}

function formatOrphanMessage(payload: DelegationOrphanDetectedPayload): ProjectedMessage {
  return {
    eventName: "delegation.orphan_detected",
    summary: `Subagent orphaned: session ${payload.orphanSessionId}, idle ${payload.idleDurationMs}ms`,
    details: {
      orphanSessionId: payload.orphanSessionId,
      lastKnownParentSessionId: payload.lastKnownParentSessionId,
      idleDurationMs: payload.idleDurationMs,
    },
  };
}

function formatToolVisibleMessage(
  payload: DelegationToolVisiblePayload,
  projectToolCalledEvents: boolean = PROJECT_TOOL_CALLED_EVENTS,
): ProjectedMessage | null {
  // Skip "called" phase events unless explicitly enabled
  if (payload.phase === "called" && !projectToolCalledEvents) return null;

  const summary =
    payload.phase === "completed"
      ? `Subagent tool completed: ${payload.toolName} (${payload.durationMs ?? 0}ms)`
      : payload.phase === "denied"
        ? `Subagent tool denied: ${payload.toolName} — ${payload.reason ?? "policy"}`
        : `Subagent tool called: ${payload.toolName}`;

  return {
    eventName: "delegation.tool_visible",
    summary,
    details: {
      childSessionId: payload.childSessionId,
      toolName: payload.toolName,
      phase: payload.phase,
      durationMs: payload.durationMs,
      reason: payload.reason,
    },
  };
}

// ── The projection extension ─────────────────────────────────────

export interface DenDelegationProjectionConfig extends DelegationChannelProjectionConfig {
  /**
   * Whether to emit projected messages to the logger at info level.
   * Set to false when a ChannelProvider or other Den surface is wired.
   * Default: true.
   */
  readonly loggerEnabled?: boolean;

  /** Turn cooldown (ms) for rate-limiting turn_visible events. Default: 5000. */
  readonly turnCooldownMs?: number;

  /** Tool cooldown (ms) for rate-limiting tool_visible events. Default: 5000. */
  readonly toolCooldownMs?: number;

  /** Whether to project "called" phase tool events. Default: false. */
  readonly projectToolCalledEvents?: boolean;
}

export class DenDelegationProjectionExtension implements ServiceExtension {
  readonly id = "den-delegation-projection";
  readonly description =
    "Projects delegation lifecycle events (spawned, completed, killed, timeout, turn/tool visible) to Den-visible surface with rate limiting.";

  readonly #config: Required<Omit<DenDelegationProjectionConfig, keyof DelegationChannelProjectionConfig>>;
  readonly #channelConfig: DelegationChannelProjectionConfig;
  readonly #unsubscribers: Array<() => void> = [];
  readonly #turnStates = new Map<string, CoalescedTurnState>();
  readonly #toolStates = new Map<string, CoalescedToolState>();

  constructor(config: DenDelegationProjectionConfig = {}) {
    this.#channelConfig = {
      channelProvider: config.channelProvider,
      channelId: config.channelId,
    };
    this.#config = {
      loggerEnabled: config.loggerEnabled ?? true,
      turnCooldownMs: config.turnCooldownMs ?? DEFAULT_TURN_COOLDOWN_MS,
      toolCooldownMs: config.toolCooldownMs ?? DEFAULT_TOOL_COOLDOWN_MS,
      projectToolCalledEvents: config.projectToolCalledEvents ?? PROJECT_TOOL_CALLED_EVENTS,
    };
  }

  activate(context: ServiceExtensionContext): Promise<void> {
    const eventBus = context.eventBus;
    const logger = context.logger;

    this.#unsubscribers.push(
      eventBus.on("delegation.spawned", (payload) =>
        this.projectOrCoalesce(context, "delegation.spawned", payload, () =>
          formatSpawnedMessage(payload),
        ),
      ),
      eventBus.on("delegation.completed", (payload) => {
        // Clean up coalescing state for this child
        this.#cleanupChildState(payload.childSessionId);
        this.projectOrCoalesce(context, "delegation.completed", payload, () =>
          formatCompletedMessage(payload),
        );
      }),
      eventBus.on("delegation.killed", (payload) => {
        this.#cleanupChildState(payload.childSessionId);
        this.projectOrCoalesce(context, "delegation.killed", payload, () =>
          formatKilledMessage(payload),
        );
      }),
      eventBus.on("delegation.timeout", (payload) => {
        this.#cleanupChildState(payload.childSessionId);
        this.projectOrCoalesce(context, "delegation.timeout", payload, () =>
          formatTimeoutMessage(payload),
        );
      }),
      eventBus.on("delegation.orphan_detected", (payload) => {
        this.#cleanupChildState(payload.orphanSessionId);
        this.projectOrCoalesce(context, "delegation.orphan_detected", payload, () =>
          formatOrphanMessage(payload),
        );
      }),
      eventBus.on("delegation.turn_visible", (payload) =>
        this.handleTurnVisible(context, payload),
      ),
      eventBus.on("delegation.tool_visible", (payload) =>
        this.handleToolVisible(context, payload),
      ),
    );

    logger.info("DenDelegationProjectionExtension activated", {
      extensionId: this.id,
      turnCooldownMs: this.#config.turnCooldownMs,
      toolCooldownMs: this.#config.toolCooldownMs,
      projectToolCalledEvents: this.#config.projectToolCalledEvents,
    });

    return Promise.resolve();
  }

  deactivate(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.#turnStates.clear();
    this.#toolStates.clear();
    return Promise.resolve();
  }

  /** Access coalescing state for testing. */
  get activeTurnCoalescing(): ReadonlyMap<string, CoalescedTurnState> {
    return this.#turnStates;
  }

  /** Access coalescing state for testing. */
  get activeToolCoalescing(): ReadonlyMap<string, CoalescedToolState> {
    return this.#toolStates;
  }

  // ── Event handler plumbing ─────────────────────────────────────

  private handleTurnVisible(
    context: ServiceExtensionContext,
    payload: DelegationTurnVisiblePayload,
  ): void {
    const cooldownMs = this.#config.turnCooldownMs;
    const now = Date.now();
    let state = this.#turnStates.get(payload.childSessionId);

    if (state === undefined) {
      state = {
        childSessionId: payload.childSessionId,
        turnCount: 0,
        lastPhase: payload.phase,
        lastSeenAt: now,
        lastProjectedAt: 0,
      };
      this.#turnStates.set(payload.childSessionId, state);
    }

    state.turnCount += 1;
    state.lastPhase = payload.phase;
    state.lastSeenAt = now;

    // Always project on error
    if (payload.phase === "errored") {
      this.logProjection(context, "delegation.turn_visible", {
        childSessionId: payload.childSessionId,
        turnNumber: payload.turnNumber,
        phase: "errored",
        durationMs: payload.durationMs,
        error: payload.error,
      });
      state.lastProjectedAt = now;
      return;
    }

    // Rate limit: project only if cooldown has elapsed
    if (now - state.lastProjectedAt >= cooldownMs) {
      // Use the coalesced state for the projection
      this.logProjection(context, "delegation.turn_visible", {
        childSessionId: payload.childSessionId,
        turnNumber: payload.turnNumber,
        phase: payload.phase,
        durationMs: payload.durationMs,
        coalescedTurnCount: state.turnCount,
      });
      state.lastProjectedAt = now;
    }
  }

  private handleToolVisible(
    context: ServiceExtensionContext,
    payload: DelegationToolVisiblePayload,
  ): void {
    // Skip "called" phase projections unless enabled
    if (payload.phase === "called" && !this.#config.projectToolCalledEvents) {
      // Still track for coalesced summary
      this.updateToolCoalescing(payload);
      return;
    }

    const cooldownMs = this.#config.toolCooldownMs;
    const now = Date.now();
    const state = this.updateToolCoalescing(payload);

    // Always project denials
    if (payload.phase === "denied") {
      this.projectOrCoalesce(context, "delegation.tool_visible", payload, () =>
        formatToolVisibleMessage(payload),
      );
      state.lastProjectedAt = now;
      return;
    }

    // Rate limit: project only if cooldown has elapsed
    if (now - state.lastProjectedAt >= cooldownMs) {
      const message = formatToolVisibleMessage(payload, this.#config.projectToolCalledEvents);
      if (message !== null) {
        this.logProjection(context, message.eventName, {
          summary: message.summary,
          ...message.details,
          coalescedToolCallCount: state.toolCallCount,
          coalescedCompletedCount: state.completedCount,
        });
      }
      state.lastProjectedAt = now;
    }
  }

  private updateToolCoalescing(payload: DelegationToolVisiblePayload): CoalescedToolState {
    const now = Date.now();
    let state = this.#toolStates.get(payload.childSessionId);

    if (state === undefined) {
      state = {
        childSessionId: payload.childSessionId,
        toolCallCount: 0,
        completedCount: 0,
        deniedCount: 0,
        lastSeenAt: now,
        lastProjectedAt: 0,
      };
      this.#toolStates.set(payload.childSessionId, state);
    }

    state.toolCallCount += 1;
    if (payload.phase === "completed") state.completedCount += 1;
    if (payload.phase === "denied") state.deniedCount += 1;
    state.lastSeenAt = now;

    return state;
  }

  // ── Projection helpers ─────────────────────────────────────────

  /**
   * Project an event to the Den-visible surface, with signal-tier
   * handling. High-signal events always project; medium-signal events
   * pass through to the caller's rate-limiting logic.
   */
  private projectOrCoalesce<T>(
    context: ServiceExtensionContext,
    eventName: string,
    _payload: T,
    format: () => ProjectedMessage | null,
  ): void {
    const config = eventProjectionConfig(eventName);

    // Low signal: log only
    if (config.tier === "low") {
      context.logger.debug("delegation.event.skipped", { eventName, reason: "low_signal_tier" });
      return;
    }

    // High signal or non-rate-limited medium: always project
    const message = format();
    if (message === null) return;

    this.logProjection(context, message.eventName, { summary: message.summary, ...message.details });
  }

  private logProjection(
    context: ServiceExtensionContext,
    eventName: string,
    details: Record<string, unknown>,
  ): void {
    const summary = typeof details["summary"] === "string" ? details["summary"] : eventName;
    projectDelegationMessageToChannel({
      ...this.#channelConfig,
      logger: context.logger,
      message: { eventName, summary, details },
    });
    if (!this.#config.loggerEnabled) return;

    context.logger.info(`delegation.event.${eventName}`, {
      extensionId: this.id,
      ...details,
    });
  }

  #cleanupChildState(childSessionId: string): void {
    this.#turnStates.delete(childSessionId);
    this.#toolStates.delete(childSessionId);
  }
}
