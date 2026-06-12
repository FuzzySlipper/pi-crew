/**
 * Operator control types for delegated child sessions.
 *
 * Provides Den-visible operator actions (list, checkpoint, cancel, kill, status)
 * over delegated child sessions with policy-gated authorization.
 *
 * @module pi-core/delegation-operator-control
 */

/**
 * Actions an operator can perform on delegated child sessions.
 *
 * - list_children: enumerate active delegated children for a parent
 * - checkpoint: snapshot current state of a child session
 * - cancel: gracefully cancel a child (archive + emit killed event)
 * - kill: force kill a child (kill + archive + emit killed event)
 * - status: query whether an action is allowed under the current policy
 */
export type OperatorControlAction =
  | "list_children"
  | "checkpoint"
  | "cancel"
  | "kill"
  | "status";

/**
 * A request from an operator to perform a control action on a child session.
 */
export interface OperatorControlRequest {
  /** The action to perform. */
  readonly action: OperatorControlAction;
  /** The child session to operate on (not required for list_children). */
  readonly targetChildSessionId?: string;
  /** The parent session that owns the children. */
  readonly parentSessionId?: string;
  /** Identity of the operator making the request. */
  readonly operatorIdentity: string;
  /** Optional reason for the action (required when policy says so). */
  readonly reason?: string;
  /** Optional correlation id for tracing. */
  readonly correlation?: string;
}

/**
 * Snapshot of a child session's current state at checkpoint time.
 */
export interface ChildSessionCheckpoint {
  /** The child session id. */
  readonly childSessionId: string;
  /** Current lifecycle state. */
  readonly state: string;
  /** Tokens consumed so far, if known. */
  readonly tokensConsumed?: number;
  /** Turns used so far, if known. */
  readonly turnsUsed?: number;
  /** Duration in milliseconds since creation, if known. */
  readonly durationMs?: number;
  /** Last tool call name, if any. */
  readonly lastToolCall?: string;
  /** Current error, if any. */
  readonly error?: string;
}

/**
 * Result of an operator control action.
 *
 * Accepted means the action was performed (or is a read-only query).
 * Rejected means authorization or policy denied the action.
 */
export interface OperatorControlResult {
  /** Whether the action was accepted and performed. */
  readonly accepted: boolean;
  /** The action that was requested. */
  readonly action: OperatorControlAction;
  /** The child session id involved (if applicable). */
  readonly childSessionId?: string;
  /** Rejection reason when accepted is false. */
  readonly reason?: string;
  /** Active children (returned by list_children). */
  readonly children?: readonly UnknownServiceSessionView[];
  /** Checkpoint snapshot (returned by checkpoint). */
  readonly checkpoint?: ChildSessionCheckpoint;
}

/**
 * Minimal session view used by operator control results.
 *
 * This mirrors ServiceSessionView from pi-service but lives in pi-core
 * so it can be returned without importing pi-service types.
 */
export interface UnknownServiceSessionView {
  readonly sessionId: string;
  readonly profileId: string;
  readonly kind: string;
  readonly state: string;
  readonly parentSessionId: string | null;
  readonly rootSessionId: string;
  readonly lastActiveAt: string;
}

/**
 * Policy governing which operator control actions are allowed.
 */
export interface OperatorControlPolicy {
  /** Actions that are permitted. */
  readonly allowedActions: readonly OperatorControlAction[];
  /** Whether a reason is required for destructive actions (cancel, kill). */
  readonly requireReason: boolean;
  /** If set, only these operator identities are allowed. */
  readonly allowedOperators?: readonly string[];
}
