/**
 * Session domain types for pi-service.
 *
 * These define the session lifecycle model: conversational sessions
 * have channel bindings and session sovereignty; worker sessions have
 * a WorkerBinding tying them to a Den assignment.
 *
 * @module pi-service/sessions/types
 */

// ── Session kind ────────────────────────────────────────────────

/** The two session kinds in pi-crew. */
export type SessionKind = "conversational" | "worker";

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
  /** Conversational or worker. */
  readonly kind: SessionKind;
  /** When the session was first created (ISO-8601). */
  readonly createdAt: string;
  /** When the session was last active (ISO-8601). */
  readonly lastActiveAt: string;
  /** Lifecycle state. */
  readonly state: SessionState;
  /** Running count of messages exchanged in this session. */
  readonly messageCount: number;
  /** Channel IDs bound to this session (empty for workers). */
  readonly channelBindings: string[];
  /** Den assignment binding (null for conversational). */
  readonly workerBinding: WorkerBinding | null;
}

// ── Session config (input for creation) ─────────────────────────

/**
 * Configuration passed to `SessionManager.create` / `AgentFactory.createSession`.
 */
export interface SessionConfig {
  /** Which profile to instantiate. */
  readonly profileId: string;
  /** Conversational or worker. */
  readonly kind: SessionKind;
  /** Initial channel bindings (conversational only). */
  readonly channelBindings?: string[];
  /** Den assignment binding (worker only). */
  readonly workerBinding?: WorkerBinding;
}
