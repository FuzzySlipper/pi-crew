/**
 * DrainModeManager — manages drain mode activation/deactivation
 * for worker sessions.
 *
 * When iteration/token budget is nearly exhausted, drain mode activates:
 * all non-essential tools are removed, but cleanup/reporting tools remain.
 *
 * @module pi-tools/drain-mode
 */

import type {
  WorkerPolicy,
  DrainModeState,
  EventBus,
  Logger,
} from "@pi-crew/core";
import { DRAIN_MODE_ESSENTIAL_TOOLS } from "@pi-crew/core";

// ── DrainModeManager ──────────────────────────────────────────

/**
 * Manages drain-mode lifecycle for a single worker session.
 *
 * Drain mode removes non-essential tools but preserves:
 * - `context_status` (budget visibility)
 * - `post_structured_completion` (completion reporting)
 * - Any additional tools registered as essential via {@link addEssentialTool}.
 */
export class DrainModeManager {
  /** The current drain-mode state (null when inactive). */
  private state: DrainModeState | null = null;

  /** Additional per-instance essential tools beyond the global set. */
  private extraEssentialTools = new Set<string>();

  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    private readonly sessionId: string,
    private readonly policy: WorkerPolicy,
  ) {}

  // ── State access ──────────────────────────────────────────

  /** Whether drain mode is currently active. */
  get isActive(): boolean {
    return this.state?.active ?? false;
  }

  /** The current drain-mode state, or null if inactive. */
  get currentState(): DrainModeState | null {
    return this.state;
  }

  // ── Essential tools ───────────────────────────────────────

  /**
   * Register an additional tool that should survive drain mode.
   *
   * Useful for role-specific reporting/notification tools beyond
   * the global `context_status` and `post_structured_completion`.
   */
  addEssentialTool(toolName: string): void {
    this.extraEssentialTools.add(toolName);
    this.logger.debug("DrainModeManager: added essential tool", {
      toolName,
      sessionId: this.sessionId,
    });
  }

  /**
   * Remove a previously-added essential tool.
   */
  removeEssentialTool(toolName: string): boolean {
    return this.extraEssentialTools.delete(toolName);
  }

  /**
   * Check whether a given tool name is essential and should
   * survive drain mode.
   */
  isEssential(toolName: string): boolean {
    return (
      DRAIN_MODE_ESSENTIAL_TOOLS.has(toolName) ||
      this.extraEssentialTools.has(toolName)
    );
  }

  // ── Tool filtering ────────────────────────────────────────

  /**
   * Filter a list of tool names, keeping only those that survive
   * drain mode (essential tools) when drain mode is active.
   *
   * When drain mode is NOT active, all tools pass through unchanged.
   */
  filterForDrain(toolNames: string[]): string[] {
    if (!this.isActive) {
      return toolNames;
    }

    const surviving = toolNames.filter((name) => this.isEssential(name));

    if (surviving.length < toolNames.length) {
      this.logger.info("DrainModeManager: tools removed by drain filter", {
        sessionId: this.sessionId,
        before: toolNames.length,
        after: surviving.length,
        removed: toolNames.filter((n) => !surviving.includes(n)),
      });
    }

    return surviving;
  }

  // ── Activation / deactivation ─────────────────────────────

  /**
   * Activate drain mode for this session.
   *
   * Emits `drain.activated` event on the bus.
   *
   * @param reason — Why drain mode is being activated.
   */
  activate(
    reason: DrainModeState["reason"],
  ): void {
    if (this.isActive) {
      this.logger.warn("DrainModeManager: drain already active", {
        sessionId: this.sessionId,
      });
      return;
    }

    this.state = {
      active: true,
      reason,
      activatedAt: new Date().toISOString(),
    };

    this.logger.warn("DrainModeManager: drain activated", {
      sessionId: this.sessionId,
      reason,
      assignmentId: this.policy.assignmentId,
    });

    this.eventBus.emit({
      event: "drain.activated",
      payload: {
        sessionId: this.sessionId,
        reason,
        assignmentId: this.policy.assignmentId,
        runId: undefined,
        taskId: undefined,
      },
    });
  }

  /**
   * Deactivate drain mode (e.g., fresh session start).
   *
   * Emits `drain.deactivated` event on the bus.
   */
  deactivate(): void {
    if (!this.isActive) {
      return;
    }

    this.state = null;

    this.logger.info("DrainModeManager: drain deactivated", {
      sessionId: this.sessionId,
    });

    this.eventBus.emit({
      event: "drain.deactivated",
      payload: {
        sessionId: this.sessionId,
        assignmentId: this.policy.assignmentId,
        runId: undefined,
      },
    });
  }

  /**
   * Check whether iteration budget suggests drain mode should activate.
   *
   * @param currentIteration — Current iteration count.
   * @returns `true` if drain should be active (budget low).
   */
  shouldDrainForIterations(currentIteration: number): boolean {
    const threshold = this.policy.maxIterations * 0.8;
    return currentIteration >= threshold;
  }

  /**
   * Auto-activate drain mode based on iteration budget check.
   *
   * Idempotent — if drain is already active, this is a no-op.
   *
   * @returns `true` if drain was activated (or was already active).
   */
  autoActivateForIterations(currentIteration: number): boolean {
    if (this.isActive) {
      return true;
    }
    if (this.shouldDrainForIterations(currentIteration)) {
      this.activate("iteration_budget");
      return true;
    }
    return false;
  }
}
