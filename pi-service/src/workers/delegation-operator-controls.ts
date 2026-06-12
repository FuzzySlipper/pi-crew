/**
 * Delegation operator controls — Den-visible operator actions for delegated child sessions.
 *
 * Provides list, checkpoint, cancel, kill, and status operations with
 * policy-gated authorization and event emission for audit visibility.
 *
 * @module pi-service/workers/delegation-operator-controls
 */

import type {
  ChildSessionCheckpoint,
  EventBus,
  Logger,
  OperatorControlAction,
  OperatorControlPolicy,
  OperatorControlResult,
  UnknownServiceSessionView,
} from "@pi-crew/core";
import type {
  DelegationSessionBridge,
  ServiceSessionView,
} from "../extension-activator.js";

/** Constructor dependencies for {@link DelegationOperatorControls}. */
export interface DelegationOperatorControlsConfig {
  readonly bridge: DelegationSessionBridge;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly policy: OperatorControlPolicy;
}

/**
 * Service for Den-visible operator control actions over delegated child sessions.
 *
 * Every action emits `operator.control_requested` before execution and
 * `operator.control_completed` after, providing full audit visibility.
 * Authorization is checked against the injected {@link OperatorControlPolicy}.
 */
export class DelegationOperatorControls {
  readonly #bridge: DelegationSessionBridge;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #policy: OperatorControlPolicy;

  constructor(config: DelegationOperatorControlsConfig) {
    this.#bridge = config.bridge;
    this.#eventBus = config.eventBus;
    this.#logger = config.logger;
    this.#policy = config.policy;
  }

  /**
   * List active delegated children for a parent session.
   */
  async listChildren(
    parentSessionId: string,
    operator: string,
    correlation?: string,
  ): Promise<OperatorControlResult> {
    const action: OperatorControlAction = "list_children";
    this.#emitRequested({ operator, action, parentSessionId, correlation });

    const authResult = this.#authorize(action, operator);
    if (!authResult.authorized) {
      const result: OperatorControlResult = {
        accepted: false,
        action,
        reason: authResult.reason,
      };
      this.#emitCompleted({
        operator,
        action,
        parentSessionId,
        correlation,
        accepted: false,
        rejectionReason: authResult.reason,
      });
      return result;
    }

    const children = await this.#bridge.listChildSessions(parentSessionId);
    const mapped: readonly UnknownServiceSessionView[] = children.map(toUnknownView);

    this.#logger.info("operator.list_children", {
      parentSessionId,
      childCount: mapped.length,
      operator,
    });

    const result: OperatorControlResult = {
      accepted: true,
      action,
      children: mapped,
    };
    this.#emitCompleted({
      operator,
      action,
      parentSessionId,
      correlation,
      accepted: true,
    });
    return result;
  }

  /**
   * Return a checkpoint snapshot of a child session's current state.
   */
  async checkpoint(
    childSessionId: string,
    operator: string,
    correlation?: string,
  ): Promise<OperatorControlResult> {
    const action: OperatorControlAction = "checkpoint";
    this.#emitRequested({ operator, action, childSessionId, correlation });

    const authResult = this.#authorize(action, operator);
    if (!authResult.authorized) {
      const result: OperatorControlResult = {
        accepted: false,
        action,
        childSessionId,
        reason: authResult.reason,
      };
      this.#emitCompleted({
        operator,
        action,
        childSessionId,
        correlation,
        accepted: false,
        rejectionReason: authResult.reason,
      });
      return result;
    }

    const session = await this.#bridge.getSession(childSessionId);
    if (session === null) {
      const result: OperatorControlResult = {
        accepted: false,
        action,
        childSessionId,
        reason: "child session not found",
      };
      this.#emitCompleted({
        operator,
        action,
        childSessionId,
        correlation,
        accepted: false,
        rejectionReason: "child session not found",
      });
      return result;
    }

    const checkpointData: ChildSessionCheckpoint = {
      childSessionId: session.sessionId,
      state: session.state,
    };

    this.#logger.info("operator.checkpoint", {
      childSessionId,
      state: session.state,
      operator,
    });

    const result: OperatorControlResult = {
      accepted: true,
      action,
      childSessionId,
      checkpoint: checkpointData,
    };
    this.#emitCompleted({
      operator,
      action,
      childSessionId,
      correlation,
      accepted: true,
    });
    return result;
  }

  /**
   * Gracefully cancel a child session (archive + emit killed event).
   */
  async cancelChild(
    childSessionId: string,
    operator: string,
    reason: string,
    correlation?: string,
  ): Promise<OperatorControlResult> {
    const action: OperatorControlAction = "cancel";
    this.#emitRequested({
      operator,
      action,
      childSessionId,
      reason,
      correlation,
    });

    const authResult = this.#authorize(action, operator, reason);
    if (!authResult.authorized) {
      const result: OperatorControlResult = {
        accepted: false,
        action,
        childSessionId,
        reason: authResult.reason,
      };
      this.#emitCompleted({
        operator,
        action,
        childSessionId,
        reason,
        correlation,
        accepted: false,
        rejectionReason: authResult.reason,
      });
      return result;
    }

    await this.#bridge.archiveChildSession(
      childSessionId,
      `cancelled by operator ${operator}: ${reason}`,
    );

    this.#logger.info("operator.cancel_child", {
      childSessionId,
      operator,
      reason,
    });

    const result: OperatorControlResult = {
      accepted: true,
      action,
      childSessionId,
      reason,
    };
    this.#emitCompleted({
      operator,
      action,
      childSessionId,
      reason,
      correlation,
      accepted: true,
    });
    return result;
  }

  /**
   * Force kill a child session (kill + archive + emit killed event).
   */
  async killChild(
    childSessionId: string,
    operator: string,
    reason: string,
    correlation?: string,
  ): Promise<OperatorControlResult> {
    const action: OperatorControlAction = "kill";
    this.#emitRequested({
      operator,
      action,
      childSessionId,
      reason,
      correlation,
    });

    const authResult = this.#authorize(action, operator, reason);
    if (!authResult.authorized) {
      const result: OperatorControlResult = {
        accepted: false,
        action,
        childSessionId,
        reason: authResult.reason,
      };
      this.#emitCompleted({
        operator,
        action,
        childSessionId,
        reason,
        correlation,
        accepted: false,
        rejectionReason: authResult.reason,
      });
      return result;
    }

    await this.#bridge.killChildSession(
      childSessionId,
      `killed by operator ${operator}: ${reason}`,
    );
    await this.#bridge.archiveChildSession(
      childSessionId,
      `archived after kill by operator ${operator}: ${reason}`,
    );

    this.#logger.info("operator.kill_child", {
      childSessionId,
      operator,
      reason,
    });

    const result: OperatorControlResult = {
      accepted: true,
      action,
      childSessionId,
      reason,
    };
    this.#emitCompleted({
      operator,
      action,
      childSessionId,
      reason,
      correlation,
      accepted: true,
    });
    return result;
  }

  /**
   * Query whether an action is allowed under the current policy.
   */
  async status(
    operator: string,
    correlation?: string,
  ): Promise<OperatorControlResult> {
    const action: OperatorControlAction = "status";
    this.#emitRequested({ operator, action, correlation });

    const allowedActions = this.#policy.allowedActions;
    const requireReason = this.#policy.requireReason;
    const allowedOperators = this.#policy.allowedOperators;

    const result: OperatorControlResult = {
      accepted: true,
      action,
      reason: `policy: ${allowedActions.length} actions allowed, requireReason=${String(requireReason)}, operatorAllowlist=${allowedOperators !== undefined ? String(allowedOperators.length) : "none"}`,
    };
    this.#emitCompleted({
      operator,
      action,
      correlation,
      accepted: true,
    });
    return result;
  }

  // ── Private helpers ──────────────────────────────────────────

  #authorize(
    action: OperatorControlAction,
    operator: string,
    reason?: string,
  ): { authorized: true } | { authorized: false; reason: string } {
    if (!this.#policy.allowedActions.includes(action)) {
      return {
        authorized: false,
        reason: `action '${action}' not in allowed actions`,
      };
    }

    if (
      this.#policy.allowedOperators !== undefined &&
      this.#policy.allowedOperators.length > 0 &&
      !this.#policy.allowedOperators.includes(operator)
    ) {
      return {
        authorized: false,
        reason: `operator '${operator}' not in allowed operators`,
      };
    }

    if (
      this.#policy.requireReason &&
      (action === "cancel" || action === "kill") &&
      (reason === undefined || reason.trim().length === 0)
    ) {
      return {
        authorized: false,
        reason: `reason required for action '${action}'`,
      };
    }

    return { authorized: true };
  }

  #emitRequested(fields: {
    operator: string;
    action: OperatorControlAction;
    childSessionId?: string;
    parentSessionId?: string;
    reason?: string;
    correlation?: string;
  }): void {
    this.#eventBus.emit({
      event: "operator.control_requested",
      payload: {
        operatorIdentity: fields.operator,
        action: fields.action,
        childSessionId: fields.childSessionId,
        parentSessionId: fields.parentSessionId,
        reason: fields.reason,
        correlation: fields.correlation,
      },
    });
  }

  #emitCompleted(fields: {
    operator: string;
    action: OperatorControlAction;
    childSessionId?: string;
    parentSessionId?: string;
    reason?: string;
    correlation?: string;
    accepted: boolean;
    rejectionReason?: string;
  }): void {
    this.#eventBus.emit({
      event: "operator.control_completed",
      payload: {
        operatorIdentity: fields.operator,
        action: fields.action,
        childSessionId: fields.childSessionId,
        parentSessionId: fields.parentSessionId,
        reason: fields.reason,
        correlation: fields.correlation,
        accepted: fields.accepted,
        rejectionReason: fields.rejectionReason,
      },
    });
  }
}

/** Convert a ServiceSessionView to a pi-core UnknownServiceSessionView. */
function toUnknownView(view: ServiceSessionView): UnknownServiceSessionView {
  return {
    sessionId: view.sessionId,
    profileId: view.profileId,
    kind: view.kind,
    state: view.state,
    parentSessionId: view.parentSessionId,
    rootSessionId: view.rootSessionId,
    lastActiveAt: view.lastActiveAt,
  };
}
