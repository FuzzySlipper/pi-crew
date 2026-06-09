/**
 * Typed event system for the pi-crew gateway.
 *
 * Dot-style event names provide a flat, machine-readable namespace
 * that maps naturally to subscription patterns without hierarchical
 * routing complexity.
 *
 * @module pi-core/events
 */

import type { ChannelMembershipStatus, ChannelSubscriptionStatus } from "./channel-presence.js";

// ── Event payloads ──────────────────────────────────────────────

/** Optional Den worker correlation carried by runtime-originated events. */
export interface DenWorkerCorrelationPayload {
  readonly policyId?: string;
  readonly assignmentId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly profileId?: string;
}

/** Fired when a new conversational or worker session is created. */
export interface SessionCreatedPayload {
  readonly sessionId: string;
  readonly kind: "conversational" | "worker";
}

/** Fired when a session is routed to (including fallback-creation visibility). */
export interface SessionRoutingPayload {
  readonly sessionId: string;
  readonly channelId: string;
  readonly reason: "existing_session" | "fallback_created";
}

/** Fired when a session expires or is explicitly released. */
export interface SessionExpiredPayload {
  readonly sessionId: string;
  readonly reason: string;
}

/** Fired when an agent tool invocation begins. */
export interface ToolCalledPayload extends DenWorkerCorrelationPayload {
  readonly toolName: string;
  readonly sessionId: string;
  /** Optional raw parameters for audit logging. */
  readonly params?: unknown;
}

/** Fired when an agent tool invocation completes (success or failure). */
export interface ToolCompletedPayload extends DenWorkerCorrelationPayload {
  readonly toolName: string;
  readonly sessionId: string;
  readonly success: boolean;
  readonly durationMs: number;
  /** Optional raw result for audit logging. */
  readonly result?: unknown;
}

/**
 * Fired when structured data is written to the blackboard.
 *
 * Deferred for the initial pi-crew implementation. Den docs
 * `planning-clarifications-v1` §10 and `submodule-architecture` define
 * pi-memory/blackboard as deferred; Den remains authoritative for durable
 * workflow state. Keep this type only for future-compatible event plumbing.
 */
export interface BlackboardWrittenPayload {
  readonly entryId: string;
  readonly sessionId: string;
}

/** Fired when a worker claims an assignment from the pool. */
export interface AssignmentClaimedPayload {
  readonly assignmentId: number;
  readonly workerIdentity: string;
  readonly taskId: number;
}

/** Fired when a worker releases an assignment back to the pool. */
export interface AssignmentReleasedPayload {
  readonly assignmentId: number;
  readonly workerIdentity: string;
  readonly reason: string;
}

/** Fired when a worker assignment exceeds its duration timeout. */
export interface AssignmentTimedOutPayload {
  readonly assignmentId: number;
  readonly runId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly role: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly reason: string;
}

/** Fired when a turn (agent reasoning step) begins. */
export interface TurnStartedPayload extends DenWorkerCorrelationPayload {
  readonly sessionId: string;
  readonly turnNumber: number;
}

/** Fired when a turn completes successfully. */
export interface TurnCompletedPayload extends DenWorkerCorrelationPayload {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly durationMs: number;
}

/** Fired when a turn encounters an error. */
export interface TurnErroredPayload {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly error: string;
}

/** Fired when a turn exhausts its tool-call or token budget. */
export interface TurnExhaustedPayload {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly reason: string;
}

/** Fired when a worker enters a checkpoint and waits for orchestrator input. */
export interface CheckpointWaitingPayload {
  readonly workerIdentity: string;
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly checkpointId?: string;
  readonly reason: string;
  readonly since: string;
}

/** Fired when the context window approaches its limit. */
export interface ContextPressurePayload {
  readonly sessionId: string;
  readonly usedTokens: number;
  readonly maxTokens: number;
}

/** Fired when a worker signals it cannot make progress. */
export interface WorkerStuckPayload {
  readonly workerIdentity: string;
  readonly assignmentId: number;
  /** Den correlation IDs for the assignment. */
  readonly runId?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly profileId?: string;
  readonly role?: string;
  /** ISO timestamp of last worker activity. */
  readonly lastActivityAt: string;
  /** Last known lifecycle state (e.g. "executing", "checkpoint_waiting"). */
  readonly lastLifecycleState: string;
  /** The idle timeout that was exceeded (ms). */
  readonly idleTimeoutMs: number;
  /** True when diagnostics/remediation should surface this local worker/session. */
  readonly remediationRequired: boolean;
  readonly reason: string;
}

/** Fired when the gateway begins graceful shutdown. */
export interface GatewayShutdownPayload {
  readonly reason: string;
}

/** Fired when a tool call is denied by the policy enforcer. */
export interface ToolDeniedPayload {
  readonly toolName: string;
  readonly sessionId: string;
  readonly reason: string;
  /** Policy and optional Den correlation IDs. */
  readonly policyId?: string;
  readonly assignmentId?: string;
  readonly runId?: string;
  readonly taskId?: string;
}

/** Fired when drain mode is activated for a session. */
export interface DrainActivatedPayload {
  readonly sessionId: string;
  readonly reason: "iteration_budget" | "context_limit" | "timeout" | "policy";
  /** Policy and optional Den correlation IDs. */
  readonly policyId?: string;
  readonly assignmentId?: string;
  readonly runId?: string;
  readonly taskId?: string;
}

/** Fired when drain mode is deactivated (e.g., fresh session start). */
export interface DrainDeactivatedPayload {
  readonly sessionId: string;
  /** Policy and optional Den correlation IDs. */
  readonly policyId?: string;
  readonly assignmentId?: string;
  readonly runId?: string;
}

/** Fired when a policy enforcement check occurs (e.g., path/network/tool). */
export interface PolicyEnforcedPayload {
  readonly sessionId: string;
  readonly checkKind: "path" | "tool" | "host" | "timeout" | "credential";
  readonly allowed: boolean;
  readonly detail: string;
  /** Policy and optional Den correlation IDs. */
  readonly policyId?: string;
  readonly assignmentId?: string;
  readonly runId?: string;
  readonly taskId?: string;
}

/** Fired when a worker posts a structured completion packet. */
export interface CompletionPostedPayload {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly status: string;
  readonly accepted: boolean;
}

/** Fired when a conversational session is rehydrated after instance eviction. */
export interface SessionRehydratedPayload {
  readonly sessionId: string;
  readonly profileId: string;
  readonly channelId: string;
  readonly oldInstanceId: string | null;
  readonly newInstanceId: string;
  readonly reason: "idle_session" | "instance_missing";
}

/** Fired when a conversational session needs provider presence reconciliation. */
export interface SessionPresenceBindingPayload {
  readonly providerId?: string;
  readonly channelId: string;
  readonly memberIdentity?: string;
  readonly profileIdentity?: string;
  readonly memberRole?: string;
  readonly subscriptionIdentity?: string;
  readonly sessionOwnerId?: string;
}

/** Fired for non-chat session lifecycle transitions that affect presence. */
export interface SessionPresencePayload {
  readonly sessionId: string;
  readonly profileId: string;
  readonly kind: "conversational";
  readonly channelBinding: SessionPresenceBindingPayload;
  readonly agentInstanceId: string | null;
  readonly subscriptionStatus: ChannelSubscriptionStatus;
  readonly membershipStatus?: ChannelMembershipStatus;
  readonly reason:
    | "created"
    | "routed"
    | "rehydrated"
    | "idle_evicted"
    | "archived"
    | "bound"
    | "unbound";
}

/** Fired when an authenticated local admin control request is accepted for evaluation. */
export interface AdminControlRequestedPayload {
  readonly action: string;
  readonly operator: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly dryRun: boolean;
}

/** Fired after a local admin control request records audit evidence. */
export interface AdminControlCompletedPayload extends AdminControlRequestedPayload {
  readonly accepted: boolean;
  readonly localAuditId: number;
}

// ── GatewayEvent union ──────────────────────────────────────────

/**
 * Discriminated union of all gateway lifecycle events.
 *
 * The `event` field uses dot-style names (e.g. `"session.created"`).
 * Narrow on `event` to access the typed payload.
 */
export type GatewayEvent =
  | { event: "session.created"; payload: SessionCreatedPayload }
  | { event: "session.routing"; payload: SessionRoutingPayload }
  | { event: "session.expired"; payload: SessionExpiredPayload }
  | { event: "tool.called"; payload: ToolCalledPayload }
  | { event: "tool.completed"; payload: ToolCompletedPayload }
  | { event: "blackboard.written"; payload: BlackboardWrittenPayload }
  | { event: "assignment.claimed"; payload: AssignmentClaimedPayload }
  | { event: "assignment.released"; payload: AssignmentReleasedPayload }
  | { event: "assignment.timed_out"; payload: AssignmentTimedOutPayload }
  | { event: "turn.started"; payload: TurnStartedPayload }
  | { event: "turn.completed"; payload: TurnCompletedPayload }
  | { event: "turn.errored"; payload: TurnErroredPayload }
  | { event: "turn.exhausted"; payload: TurnExhaustedPayload }
  | { event: "checkpoint.waiting"; payload: CheckpointWaitingPayload }
  | { event: "context.pressure"; payload: ContextPressurePayload }
  | { event: "worker.stuck"; payload: WorkerStuckPayload }
  | { event: "gateway.shutdown"; payload: GatewayShutdownPayload }
  | { event: "tool.denied"; payload: ToolDeniedPayload }
  | { event: "drain.activated"; payload: DrainActivatedPayload }
  | { event: "drain.deactivated"; payload: DrainDeactivatedPayload }
  | { event: "policy.enforced"; payload: PolicyEnforcedPayload }
  | { event: "completion.posted"; payload: CompletionPostedPayload }
  | { event: "session.rehydrated"; payload: SessionRehydratedPayload }
  | { event: "session.presence"; payload: SessionPresencePayload }
  | { event: "admin.control.requested"; payload: AdminControlRequestedPayload }
  | { event: "admin.control.completed"; payload: AdminControlCompletedPayload };

/**
 * Helper to extract the payload type for a specific event name.
 *
 * @example
 * ```ts
 * type P = EventPayload<"session.created">; // SessionCreatedPayload
 * ```
 */
export type EventPayload<E extends GatewayEvent["event"]> = Extract<
  GatewayEvent,
  { event: E }
>["payload"];

// ── EventBus interface ──────────────────────────────────────────

/**
 * Type-safe event bus contract.
 *
 * The gateway composes modules by having them emit and subscribe to
 * events on a shared bus.  No module imports from another module
 * directly — the bus is the decoupling mechanism.
 */
export interface EventBus {
  /**
   * Emit a typed gateway event to all registered listeners.
   */
  emit(event: GatewayEvent): void;

  /**
   * Subscribe to a specific event name.  Returns an unsubscribe function.
   */
  on<E extends GatewayEvent["event"]>(
    event: E,
    handler: (payload: EventPayload<E>) => void,
  ): () => void;

  /**
   * Remove a specific handler for an event.
   */
  off<E extends GatewayEvent["event"]>(event: E, handler: (payload: EventPayload<E>) => void): void;
}
