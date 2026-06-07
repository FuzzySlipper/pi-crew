/**
 * context_status tool — exposes context pressure/budget status.
 *
 * Agents call this tool to make budget-aware decisions before
 * launching expensive operations (research, worker spawns, etc.).
 *
 * @module pi-tools/context-status
 */

import type { ContextPressureSnapshot, EventBus, Logger } from "@pi-crew/core";
import type { DrainModeManager } from "./drain-mode.js";

// ── Context usage tracker ────────────────────────────────────

/**
 * Tracks live context window usage across turns.
 *
 * In production this integrates with pi-agent-core token-usage data
 * fed from AgentSupervisor's `message_end` events.  For v1 it accepts
 * externally-reported snapshots and incremental deltas.
 */
export interface ContextUsageTracker {
  /** Current estimated usage (0-100 percent). */
  readonly usagePercent: number;
  /** Estimated tokens used. */
  readonly tokensUsed: number;
  /** Estimated tokens remaining. */
  readonly tokensRemaining: number;
  /** Total token capacity. */
  readonly tokensTotal: number;
  /** Rough estimate of remaining turns. */
  readonly turnsRemainingEstimate: number;

  /**
   * Apply an externally-reported snapshot.
   *
   * Used when the provider reports actual token counts.
   * Replaces the entire state.
   */
  update(usage: { tokensUsed: number; tokensTotal: number; turnsRemainingEstimate: number }): void;

  /**
   * Accumulate incremental token usage from a single turn or tool call.
   *
   * Used by AgentSupervisor to feed pi-agent-core token data as it
   * arrives from `message_end` events.  Unlike `update`, this adds
   * rather than replaces.
   */
  accumulate(delta: { tokensUsed: number }): void;
}

/**
 * Default in-memory {@link ContextUsageTracker} implementation.
 *
 * Starts with zero usage. Updated via {@link update}, {@link accumulate},
 * or directly by the agent loop middleware.
 */
export class ContextUsageTrackerImpl implements ContextUsageTracker {
  private _tokensUsed = 0;
  private _tokensTotal = 200_000;
  private _turnsRemainingEstimate = 10;

  constructor(initial?: {
    tokensUsed: number;
    tokensTotal: number;
    turnsRemainingEstimate: number;
  }) {
    if (initial) {
      this._tokensUsed = initial.tokensUsed;
      this._tokensTotal = initial.tokensTotal;
      this._turnsRemainingEstimate = initial.turnsRemainingEstimate;
    }
  }

  get usagePercent(): number {
    if (this._tokensTotal <= 0) return 0;
    const pct = (this._tokensUsed / this._tokensTotal) * 100;
    return Math.round(pct * 100) / 100;
  }

  get tokensUsed(): number {
    return this._tokensUsed;
  }

  get tokensRemaining(): number {
    return Math.max(0, this._tokensTotal - this._tokensUsed);
  }

  get tokensTotal(): number {
    return this._tokensTotal;
  }

  get turnsRemainingEstimate(): number {
    return this._turnsRemainingEstimate;
  }

  update(usage: { tokensUsed: number; tokensTotal: number; turnsRemainingEstimate: number }): void {
    this._tokensUsed = usage.tokensUsed;
    this._tokensTotal = usage.tokensTotal;
    this._turnsRemainingEstimate = usage.turnsRemainingEstimate;
  }

  accumulate(delta: { tokensUsed: number }): void {
    this._tokensUsed += delta.tokensUsed;
  }
}

// ── Token pressure emitter ───────────────────────────────────

/**
 * Threshold percentages at which `context.pressure` events fire.
 *
 * Each threshold fires exactly once per session — once crossed,
 * subsequent crossings above the same level do not re-emit.
 */
const PRESSURE_THRESHOLDS = [70, 85, 95] as const;

/**
 * Emits `context.pressure` events when token-usage thresholds are
 * crossed for the first time in a session.
 *
 * Usage: create one per worker session.  Call {@link checkAndEmit}
 * after every turn (or whenever the token tracker is updated) to
 * fire pressure events at 70%, 85%, and 95% usage.
 */
export class TokenPressureEmitter {
  /** Thresholds that have already been crossed and emitted. */
  readonly #emitted = new Set<number>();

  /**
   * Check current token usage against pressure thresholds and emit
   * `context.pressure` events for any newly-crossed thresholds.
   *
   * @param tracker — The context usage tracker for this session.
   * @param sessionId — Session ID for event correlation.
   * @param eventBus — Gateway event bus for emitting events.
   * @param logger — Optional logger for diagnostic output.
   */
  checkAndEmit(
    tracker: ContextUsageTracker,
    sessionId: string,
    eventBus: EventBus,
    logger?: Logger,
  ): void {
    const pct = tracker.usagePercent;

    for (const threshold of PRESSURE_THRESHOLDS) {
      if (this.#emitted.has(threshold)) continue;
      if (pct >= threshold) {
        this.#emitted.add(threshold);

        eventBus.emit({
          event: "context.pressure",
          payload: {
            sessionId,
            usedTokens: tracker.tokensUsed,
            maxTokens: tracker.tokensTotal,
          },
        });

        logger?.warn(`TokenPressureEmitter: context pressure ${String(threshold)}%`, {
          sessionId,
          usagePercent: pct,
          threshold,
          tokensUsed: tracker.tokensUsed,
          tokensTotal: tracker.tokensTotal,
        });
      }
    }
  }

  /** Reset all emitted thresholds (e.g., session restart). */
  reset(): void {
    this.#emitted.clear();
  }
}

// ── context_status tool ──────────────────────────────────────

/** Configuration for the {@link contextStatusTool}. */
export interface ContextStatusConfig {
  /** Compression threshold percent (default 70). */
  readonly compressionThreshold?: number;
  /** Critical threshold percent (default 85). */
  readonly criticalThreshold?: number;
  /** Session-scoped pressure emitter used to deduplicate inline events. */
  readonly pressureEmitter?: TokenPressureEmitter;
}

const DEFAULT_COMPRESSION_THRESHOLD = 70;
const DEFAULT_CRITICAL_THRESHOLD = 85;
const INLINE_PRESSURE_EMITTERS = new WeakMap<EventBus, Map<string, TokenPressureEmitter>>();

function resolveInlinePressureEmitter(
  eventBus: EventBus,
  sessionId: string,
  configured?: TokenPressureEmitter,
): TokenPressureEmitter {
  if (configured) return configured;
  const bySession =
    INLINE_PRESSURE_EMITTERS.get(eventBus) ?? new Map<string, TokenPressureEmitter>();
  if (!INLINE_PRESSURE_EMITTERS.has(eventBus)) {
    INLINE_PRESSURE_EMITTERS.set(eventBus, bySession);
  }
  const existing = bySession.get(sessionId);
  if (existing) return existing;
  const created = new TokenPressureEmitter();
  bySession.set(sessionId, created);
  return created;
}

/**
 * The `context_status` tool returns a snapshot of the current
 * context window usage with a human-readable recommendation.
 *
 * @param tracker — The context usage tracker for this session.
 * @param drainManager — Optional drain-mode manager for drain status.
 * @param config — Optional threshold overrides.
 * @param eventBus — Optional event bus for pressure warnings.
 * @param logger — Optional logger.
 * @param sessionId — Session ID for event correlation.
 */
export function contextStatusTool(
  tracker: ContextUsageTracker,
  drainManager: DrainModeManager | null,
  config?: ContextStatusConfig,
  eventBus?: EventBus,
  logger?: Logger,
  sessionId?: string,
): ContextPressureSnapshot {
  const compressionThreshold = config?.compressionThreshold ?? DEFAULT_COMPRESSION_THRESHOLD;
  const criticalThreshold = config?.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD;

  const pct = tracker.usagePercent;
  const compressionImminent = pct > compressionThreshold;
  const critical = pct > criticalThreshold;
  const drainActive = drainManager?.isActive ?? false;

  let recommendation: string;
  if (pct > 95) {
    recommendation = "EMERGENCY: Context nearly full. Stop all non-essential work immediately.";
  } else if (critical) {
    recommendation =
      "CRITICAL: Avoid launching new workers or large research tasks. Consider handoff or compaction.";
  } else if (compressionImminent) {
    recommendation = "WARNING: Compression imminent. Avoid large context-loading operations.";
  } else {
    recommendation = "Normal. Safe to proceed.";
  }

  const snapshot: ContextPressureSnapshot = {
    usagePercent: pct,
    tokensUsed: tracker.tokensUsed,
    tokensRemaining: tracker.tokensRemaining,
    tokensTotal: tracker.tokensTotal,
    compressionImminent,
    compressionThreshold,
    turnsRemainingEstimate: tracker.turnsRemainingEstimate,
    recommendation,
    drainActive,
  };

  // Emit pressure event if crossing a threshold (best-effort inline).
  // DESIGN: Inline calls use the session-scoped TokenPressureEmitter so
  // repeated context_status invocations do not spam governance/audit with
  // duplicate context.pressure events for a threshold already crossed.
  // Rationale: context_status is an operator/worker visibility tool, while
  // pressure events are lifecycle signals that should be once-per-threshold.
  if (eventBus && sessionId && (compressionImminent || critical)) {
    const pressureEmitter = resolveInlinePressureEmitter(
      eventBus,
      sessionId,
      config?.pressureEmitter,
    );
    pressureEmitter.checkAndEmit(tracker, sessionId, eventBus, logger);
  }

  return snapshot;
}
