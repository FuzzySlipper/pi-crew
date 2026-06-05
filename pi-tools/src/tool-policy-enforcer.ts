/**
 * ToolPolicyEnforcer — enforces allowlist/denylist tool filtering
 * per worker session.
 *
 * Every tool call passes through this enforcer before execution.
 * Denied tools cannot be called even if present in the registry.
 *
 * @module pi-tools/tool-policy-enforcer
 */

import type {
  WorkerPolicy,
  EventBus,
  Logger,
} from "@pi-crew/core";
import { ToolDeniedError } from "@pi-crew/core";

// ── ToolFilterResult ──────────────────────────────────────────

/**
 * Result of checking whether a tool is allowed.
 */
export interface ToolFilterResult {
  /** Whether the tool is allowed. */
  readonly allowed: boolean;
  /** Reason why the tool was denied (empty if allowed). */
  readonly reason: string;
}

// ── ToolPolicyEnforcer ────────────────────────────────────────

/**
 * Enforces per-session tool restrictions based on {@link WorkerPolicy}.
 *
 * - Checks denylist first (explicitly denied tools).
 * - Checks allowlist second (if non-empty, only listed tools pass).
 * - Emits `tool.denied` and `policy.enforced` events on the bus.
 */
export class ToolPolicyEnforcer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
  ) {}

  /**
   * Check whether a tool is allowed for the given session policy.
   *
   * @param policy — The worker policy for the current session.
   * @param toolName — The tool name being requested.
   * @param sessionId — The session requesting the tool.
   * @returns A {@link ToolFilterResult} indicating whether the tool is allowed.
   */
  checkTool(
    policy: WorkerPolicy,
    toolName: string,
    sessionId: string,
  ): ToolFilterResult {
    // Denylist takes absolute precedence
    if (policy.deniedTools.includes(toolName)) {
      const reason = `Tool "${toolName}" is explicitly denied`;
      this.logger.warn("ToolPolicyEnforcer: tool denied (denylist)", {
        toolName,
        sessionId,
        assignmentId: policy.assignmentId,
      });
      this.emitDenied(policy, toolName, sessionId, reason);
      return { allowed: false, reason };
    }

    // If allowlist is non-empty, only listed tools pass
    if (
      policy.allowedTools.length > 0 &&
      !policy.allowedTools.includes(toolName)
    ) {
      const reason = `Tool "${toolName}" is not in the allowlist`;
      this.logger.warn("ToolPolicyEnforcer: tool denied (allowlist)", {
        toolName,
        sessionId,
        assignmentId: policy.assignmentId,
      });
      this.emitDenied(policy, toolName, sessionId, reason);
      return { allowed: false, reason };
    }

    // Tool is allowed
    this.emitEnforced(policy, sessionId, "tool", true, toolName);
    return { allowed: true, reason: "" };
  }

  /**
   * Validate that a tool is allowed, throwing on denial.
   *
   * Convenience wrapper around {@link checkTool} that throws a
   * typed error instead of returning a result object.
   *
   * @throws {ToolDeniedError} when the tool is not allowed.
   */
  requireTool(
    policy: WorkerPolicy,
    toolName: string,
    sessionId: string,
  ): void {
    const result = this.checkTool(policy, toolName, sessionId);
    if (!result.allowed) {
      throw new ToolDeniedError(result.reason, toolName);
    }
  }

  /**
   * Filter a list of tool names to only those allowed by the policy.
   *
   * @returns The subset of tool names that pass the policy check.
   */
  filterToolNames(
    policy: WorkerPolicy,
    toolNames: string[],
    sessionId: string,
  ): string[] {
    const allowed: string[] = [];
    for (const name of toolNames) {
      if (this.checkTool(policy, name, sessionId).allowed) {
        allowed.push(name);
      }
    }
    return allowed;
  }

  // ── Event emission ────────────────────────────────────────

  private emitDenied(
    policy: WorkerPolicy,
    toolName: string,
    sessionId: string,
    reason: string,
  ): void {
    this.eventBus.emit({
      event: "tool.denied",
      payload: {
        toolName,
        sessionId,
        reason,
        assignmentId: policy.assignmentId,
        runId: undefined,
        taskId: undefined,
      },
    });

    this.eventBus.emit({
      event: "policy.enforced",
      payload: {
        sessionId,
        checkKind: "tool",
        allowed: false,
        detail: reason,
        assignmentId: policy.assignmentId,
      },
    });
  }

  private emitEnforced(
    policy: WorkerPolicy,
    sessionId: string,
    checkKind: "tool",
    allowed: boolean,
    detail: string,
  ): void {
    this.eventBus.emit({
      event: "policy.enforced",
      payload: {
        sessionId,
        checkKind,
        allowed,
        detail,
        assignmentId: policy.assignmentId,
      },
    });
  }
}
