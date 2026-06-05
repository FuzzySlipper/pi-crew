/**
 * context_status tool — exposes context pressure/budget status.
 *
 * Agents call this tool to make budget-aware decisions before
 * launching expensive operations (research, worker spawns, etc.).
 *
 * @module pi-tools/context-status
 */

import type {
  ContextPressureSnapshot,
  EventBus,
  Logger,
} from "@pi-crew/core";
import type { DrainModeManager } from "./drain-mode.js";

// ── Context usage tracker ────────────────────────────────────

/**
 * Tracks live context window usage across turns.
 *
 * In production this integrates with the provider's token-counting
 * API and message history estimator. For v1 it accepts externally-
 * reported snapshots and maintains the current state.
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
   */
  update(usage: {
    tokensUsed: number;
    tokensTotal: number;
    turnsRemainingEstimate: number;
  }): void;
}

/**
 * Default in-memory {@link ContextUsageTracker} implementation.
 *
 * Starts with zero usage. Updated via {@link update} or directly
 * by the agent loop middleware.
 */
export class ContextUsageTrackerImpl implements ContextUsageTracker {
  private _tokensUsed = 0;
  private _tokensTotal = 200_000;
  private _turnsRemainingEstimate = 10;

  constructor(
    initial?: { tokensUsed: number; tokensTotal: number; turnsRemainingEstimate: number },
  ) {
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

  update(usage: {
    tokensUsed: number;
    tokensTotal: number;
    turnsRemainingEstimate: number;
  }): void {
    this._tokensUsed = usage.tokensUsed;
    this._tokensTotal = usage.tokensTotal;
    this._turnsRemainingEstimate = usage.turnsRemainingEstimate;
  }
}

// ── context_status tool ──────────────────────────────────────

/** Configuration for the {@link contextStatusTool}. */
export interface ContextStatusConfig {
  /** Compression threshold percent (default 70). */
  readonly compressionThreshold?: number;
  /** Critical threshold percent (default 85). */
  readonly criticalThreshold?: number;
}

const DEFAULT_COMPRESSION_THRESHOLD = 70;
const DEFAULT_CRITICAL_THRESHOLD = 85;

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
  const compressionThreshold =
    config?.compressionThreshold ?? DEFAULT_COMPRESSION_THRESHOLD;
  const criticalThreshold =
    config?.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD;

  const pct = tracker.usagePercent;
  const compressionImminent = pct > compressionThreshold;
  const critical = pct > criticalThreshold;
  const drainActive = drainManager?.isActive ?? false;

  let recommendation: string;
  if (critical) {
    recommendation =
      "CRITICAL: Avoid launching new workers or large research tasks. Consider handoff or compaction.";
  } else if (compressionImminent) {
    recommendation =
      "WARNING: Compression imminent. Avoid large context-loading operations.";
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

  // Emit pressure event if crossing a threshold
  if (eventBus && sessionId && (compressionImminent || critical)) {
    eventBus.emit({
      event: "context.pressure",
      payload: {
        sessionId,
        usedTokens: tracker.tokensUsed,
        maxTokens: tracker.tokensTotal,
      },
    });
    logger?.warn("context_status: context pressure warning", {
      sessionId,
      usagePercent: pct,
      compressionImminent,
      critical,
    });
  }

  return snapshot;
}
