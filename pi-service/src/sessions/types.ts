/**
 * Session domain types for pi-service.
 *
 * These define the session lifecycle model: conversational sessions
 * have channel bindings and session sovereignty; worker sessions have
 * a WorkerBinding tying them to a Den assignment.
 *
 * @module pi-service/sessions/types
 */

import type {
  DelegationConstraints,
  DelegationLineage,
  DelegationSpawnRequest,
  EffectiveDelegationRuntime,
  SessionKind,
} from "@pi-crew/core";

// ── Channel binding ─────────────────────────────────────────────

/**
 * Den-facing metadata for a conversational channel binding.
 *
 * String bindings remain supported for old persisted rows; new V2 Den
 * Channels bindings should use this structured record so session lifecycle
 * events can update membership/subscription presence without chat messages.
 */
export interface ChannelBindingRecord {
  readonly providerId: string;
  readonly channelId: string;
  readonly memberIdentity?: string;
  readonly profileIdentity?: string;
  readonly memberRole?: string;
  readonly subscriptionIdentity?: string;
  readonly sessionOwnerId?: string;
}

/** Backward-compatible channel binding shape. */
export type ChannelBinding = string | ChannelBindingRecord;

// ── Session kind ────────────────────────────────────────────────

export type { SessionKind };

// ── Session state ───────────────────────────────────────────────

/**
 * Lifecycle state for a session record.
 *
 * - `active`: instance is live and executing or ready to execute.
 * - `idle`:   instance disposed, session record still in store.
 * - `archived`: session is excluded from routing / get / findByChannel.
 */
export type SessionState = "active" | "idle" | "archived";

// ── Worker binding ──────────────────────────────────────────────

/** Target completion packet reference for validator/auditor worker roles. */
export interface WorkerTargetPacketRef {
  /** Den project ID the target packet belongs to. */
  readonly projectId: string;
  /** Den task ID the target packet belongs to. */
  readonly taskId: string;
  /** Target Den worker run ID; this is not the auditor run. */
  readonly runId: string;
}

/**
 * Den-assignment binding carried by worker sessions.
 *
 * A conversational session has `workerBinding: null`.
 * A worker session has exactly one worker binding and no channel bindings.
 */
export interface WorkerBinding {
  /** Den assignment ID. */
  readonly assignmentId: string;
  /** Den worker run ID. */
  readonly runId: string;
  /** Den task ID the assignment belongs to. */
  readonly taskId: string;
  /** Den project ID. */
  readonly projectId: string;
  /** Worker role: "coder" | "reviewer" | "validator" | "packet-auditor". */
  readonly role: string;
  /** Optional target completion packet for audit/validation roles. */
  readonly targetPacketRef?: WorkerTargetPacketRef;
}

// ── Session record ──────────────────────────────────────────────

/**
 * A durable session record stored in the runtime session store.
 *
 * The instance itself is transient (in-memory pool); the session record
 * outlives the instance and carries the identity, bindings, and state
 * needed to re-hydrate an instance when the session becomes active again.
 */
export interface SessionRecord {
  /** Unique session identifier. */
  readonly id: string;
  /** Profile ID that spawned this session. */
  readonly profileId: string;
  /** Instance ID currently bound (null when idle/archived). */
  readonly instanceId: string | null;
  /** Conversational, worker, or delegated child. */
  readonly kind: SessionKind;
  /** Delegation lineage; null for top-level conversational/worker sessions. */
  readonly delegation: DelegationLineage | null;
  /** Original spawn request retained for audit/result routing. */
  readonly delegationSpawnRequest: DelegationSpawnRequest | null;
  /** Remaining delegation budget inherited by this session's descendants. */
  readonly delegationConstraints?: DelegationConstraints | null;
  /** Effective runtime selected for this session, including model/provider overrides. */
  readonly effectiveRuntime?: EffectiveDelegationRuntime | null;
  /** When the session was first created (ISO-8601). */
  readonly createdAt: string;
  /** When the session was last active (ISO-8601). */
  readonly lastActiveAt: string;
  /** Lifecycle state. */
  readonly state: SessionState;
  /** Running count of messages exchanged in this session. */
  readonly messageCount: number;
  /** Channel bindings for this session (empty for workers). */
  readonly channelBindings: ChannelBinding[];
  /** Den assignment binding (null for conversational). */
  readonly workerBinding: WorkerBinding | null;
}

// ── Session config (input for creation) ─────────────────────────

/**
 * Configuration passed to `SessionManager.create` / `AgentFactory.createSession`.
 */
export interface SessionConfig {
  /** Optional deterministic session id for service-owned lifecycle bridges. */
  readonly sessionId?: string;
  /** Which profile to instantiate. */
  readonly profileId: string;
  /** Conversational, worker, or delegated child. */
  readonly kind: SessionKind;
  /** Initial channel bindings (conversational only). */
  readonly channelBindings?: ChannelBinding[];
  /** Den assignment binding (worker only). */
  readonly workerBinding?: WorkerBinding;
  /** Delegation lineage (delegated sessions only). */
  readonly delegation?: DelegationLineage;
  /** Spawn request used to create the child session. */
  readonly delegationSpawnRequest?: DelegationSpawnRequest;
  /** Remaining delegation budget for this delegated session. */
  readonly delegationConstraints?: DelegationConstraints;
  /** Effective runtime selected for this session. */
  readonly effectiveRuntime?: EffectiveDelegationRuntime;
}
