/**
 * SessionToolFilter — composes policy enforcement and drain-mode
 * filtering into a single per-session tool surface.
 *
 * A worker session sees only allowed tools (after deny/allow checks)
 * and, when drain mode is active, only essential tools survive.
 *
 * @module pi-tools/session-tool-filter
 */

import type { ExecutionPolicy, EventBus, Logger } from "@pi-crew/core";
import { ToolPolicyEnforcer } from "./tool-policy-enforcer.js";
import type { DrainModeManager } from "./drain-mode.js";

// ── SessionToolFilter ────────────────────────────────────────

/**
 * The single entry point for per-session tool filtering.
 *
 * Composes:
 * 1. {@link ToolPolicyEnforcer} — allowlist/denylist enforcement
 * 2. {@link DrainModeManager} — drain-mode tool reduction
 *
 * The caller provides a list of tool names and receives the subset
 * that the session is allowed to see and use.
 */
export class SessionToolFilter {
  private readonly enforcer: ToolPolicyEnforcer;

  constructor(
    eventBus: EventBus,
    logger: Logger,
  ) {
    this.enforcer = new ToolPolicyEnforcer(eventBus, logger);
  }

  /**
   * Filter a list of available tool names to only those the session
   * is permitted to use.
   *
   * Applies in order:
   * 1. Policy allowlist/denylist (via {@link ToolPolicyEnforcer})
   * 2. Drain-mode filtering (if drain is active)
   *
   * @param policy — The execution policy for this session.
   * @param sessionId — The session identifier.
   * @param toolNames — All tool names available in the registry.
   * @param drainManager — Optional drain-mode manager (null if not applicable).
   * @returns The filtered list of allowed tool names.
   */
  filter(
    policy: ExecutionPolicy,
    sessionId: string,
    toolNames: string[],
    drainManager: DrainModeManager | null,
  ): string[] {
    // Step 1: Policy enforcement
    let allowed = this.enforcer.filterToolNames(policy, toolNames, sessionId);

    // Step 2: Drain mode filtering
    if (drainManager?.isActive) {
      allowed = drainManager.filterForDrain(allowed);
    }

    return allowed;
  }

  /**
   * Check whether a single tool is allowed for a session.
   *
   * @returns `true` if the tool is allowed and survives drain.
   */
  isAllowed(
    policy: ExecutionPolicy,
    sessionId: string,
    toolName: string,
    drainManager: DrainModeManager | null,
  ): boolean {
    // Policy check
    const policyResult = this.enforcer.checkTool(policy, toolName, sessionId);
    if (!policyResult.allowed) {
      return false;
    }

    // Drain mode check
    if (drainManager?.isActive) {
      return drainManager.isEssential(toolName);
    }

    return true;
  }

  /**
   * Get the underlying enforcer for direct access when needed.
   */
  getEnforcer(): ToolPolicyEnforcer {
    return this.enforcer;
  }
}
