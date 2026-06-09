/**
 * Persistence-layer types for pi-service.
 *
 * Defines row shapes for SQLite tables, migration metadata, and
 * repository interfaces that extend or complement the generic
 * {@link Repository} from pi-core.
 *
 * @module pi-service/persistence/types
 */

import type {
  DelegationConstraints,
  EffectiveDelegationRuntime,
  DelegationLineage,
  DelegationSpawnRequest,
} from "@pi-crew/core";
import type {
  ChannelBinding,
  ChannelBindingRecord,
  SessionKind,
  SessionState,
  WorkerBinding,
} from "../sessions/types.js";
import type { SessionRecord } from "../sessions/types.js";

// ── SQLite row types ──────────────────────────────────────────────

/** Row shape for the `sessions` table. */
export interface SessionRow {
  id: string;
  kind: SessionKind;
  profile_id: string;
  channel_bindings_json: string;
  worker_binding_json: string | null;
  delegation_json: string | null;
  delegation_spawn_request_json: string | null;
  delegation_constraints_json: string | null;
  effective_runtime_json: string | null;
  status: SessionState;
  created_at: string;
  last_activity: string;
  expires_at: string | null;
}

/** Row shape for the `messages` table. */
export interface MessageRow {
  id: number;
  session_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_name: string | null;
  token_count: number | null;
  created_at: string;
}

/** Row shape for the `audit_log` table. */
export interface AuditRow {
  id: number;
  session_id: string | null;
  assignment_id: string | null;
  run_id: string | null;
  event_type: string;
  event_data: string;
  flushed: number;
  created_at: string;
}

/** Row shape for the `runtime_kv` table. */
export interface RuntimeKVRow {
  key: string;
  value: string;
  updated_at: string;
}

// ── Message input ─────────────────────────────────────────────────

/** Input for appending a message. */
export interface MessageInput {
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
  tokenCount?: number;
}

// ── Audit input ───────────────────────────────────────────────────

/** Input for writing an audit event. */
export interface AuditEventInput {
  sessionId?: string;
  assignmentId?: string;
  runId?: string;
  eventType: string;
  eventData: Record<string, unknown>;
}

// ── Migration metadata ────────────────────────────────────────────

/** A forward-only, idempotent SQL migration. */
export interface Migration {
  /** Integer version number (deterministic sort order). */
  version: number;
  /** Short description for logging. */
  name: string;
  /** Raw SQL text to execute. */
  sql: string;
}

// ── Repository contracts (persistence-specific) ───────────────────

/**
 * Persistence contract for messages scoped to a session.
 */
export interface MessageRepository {
  /** Append a message to the given session. Returns the assigned row id. */
  append(input: MessageInput): Promise<number>;

  /** Retrieve all messages for a session, ordered by id ascending. */
  getBySession(sessionId: string, limit?: number): Promise<MessageRow[]>;

  /** Count messages for a session. */
  count(sessionId: string): Promise<number>;

  /** Delete all messages for a session. */
  deleteBySession(sessionId: string): Promise<void>;
}

/**
 * Persistence contract for audit events.
 */
export interface AuditRepository {
  /** Write a single audit event (redacted at the storage boundary). */
  write(input: AuditEventInput): Promise<number>;

  /** Return unflushed audit events, ordered by id ascending. */
  getPending(limit?: number): Promise<AuditRow[]>;

  /** Mark a set of audit events as flushed. */
  markFlushed(ids: number[]): Promise<void>;

  /** Delete audit events older than a cutoff ISO timestamp. */
  pruneOlderThan(cutoff: string): Promise<number>;
}

/**
 * Extended session repository for SQLite-backed persistence.
 *
 * Implements the existing {@link import("../sessions/session-store.js").SessionStore}
 * contract and adds hydration-specific queries.
 */
export interface SqliteSessionStore {
  /** Retrieve all sessions with a given status. */
  findByStatus(status: SessionState): Promise<SessionRecord[]>;

  /** Archive sessions whose IDs are in the supplied list. */
  archiveMany(sessionIds: string[]): Promise<number>;
}

// ── Den assignment status (injected for hydration) ────────────────

/** Lightweight Den assignment status used during hydration. */
export interface DenAssignmentStatus {
  assignmentId: string;
  /** Whether the assignment is still active in Den. */
  isActive: boolean;
  /** Den-reported terminal state if not active. */
  terminalState?: string;
}

/**
 * Contract for querying Den assignment status.
 *
 * Injected into the hydration helper so tests can provide stubs.
 */
export interface DenAssignmentReader {
  /** Check whether a set of assignment IDs are still active in Den. */
  checkAssignments(ids: string[]): Promise<DenAssignmentStatus[]>;
}

// ── Row ↔ Record conversion helpers ───────────────────────────────

/**
 * Convert a {@link SessionRow} to a domain {@link SessionRecord}.
 */
export function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    kind: row.kind,
    profileId: row.profile_id,
    instanceId: null,
    createdAt: row.created_at,
    lastActiveAt: row.last_activity,
    state: row.status,
    messageCount: 0,
    channelBindings: parseChannelBindings(row.channel_bindings_json),
    workerBinding: parseWorkerBinding(row.worker_binding_json),
    delegation: parseDelegationLineage(row.delegation_json),
    delegationSpawnRequest: parseDelegationSpawnRequest(row.delegation_spawn_request_json),
    delegationConstraints: parseDelegationConstraints(row.delegation_constraints_json),
    effectiveRuntime: parseEffectiveRuntime(row.effective_runtime_json),
  };
}

/**
 * Convert a domain {@link SessionRecord} to a {@link SessionRow}.
 */
export function recordToRow(record: SessionRecord): SessionRow {
  return {
    id: record.id,
    kind: record.kind,
    profile_id: record.profileId,
    channel_bindings_json: JSON.stringify(record.channelBindings),
    worker_binding_json: record.workerBinding
      ? JSON.stringify(record.workerBinding)
      : null,
    delegation_json: record.delegation ? JSON.stringify(record.delegation) : null,
    delegation_spawn_request_json: record.delegationSpawnRequest
      ? JSON.stringify(record.delegationSpawnRequest)
      : null,
    delegation_constraints_json: record.delegationConstraints
      ? JSON.stringify(record.delegationConstraints)
      : null,
    effective_runtime_json: record.effectiveRuntime
      ? JSON.stringify(record.effectiveRuntime)
      : null,
    status: record.state,
    created_at: record.createdAt,
    last_activity: record.lastActiveAt,
    expires_at: null,
  };
}

// ── Internal helpers ──────────────────────────────────────────────

function parseChannelBindings(raw: string): ChannelBinding[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.flatMap(parseChannelBinding);
    }
  } catch {
    // Fall through to default.
  }
  return [];
}

function parseChannelBinding(value: unknown): ChannelBinding[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.providerId !== "string" || typeof candidate.channelId !== "string") return [];
  return [{
    providerId: candidate.providerId,
    channelId: candidate.channelId,
    ...readOptionalChannelBindingFields(candidate),
  }];
}

function readOptionalChannelBindingFields(
  candidate: Record<string, unknown>,
): Omit<ChannelBindingRecord, "providerId" | "channelId"> {
  return {
    ...(typeof candidate.memberIdentity === "string" ? { memberIdentity: candidate.memberIdentity } : {}),
    ...(typeof candidate.profileIdentity === "string" ? { profileIdentity: candidate.profileIdentity } : {}),
    ...(typeof candidate.memberRole === "string" ? { memberRole: candidate.memberRole } : {}),
    ...(typeof candidate.subscriptionIdentity === "string" ? { subscriptionIdentity: candidate.subscriptionIdentity } : {}),
    ...(typeof candidate.sessionOwnerId === "string" ? { sessionOwnerId: candidate.sessionOwnerId } : {}),
  };
}

function parseWorkerBinding(raw: string | null): WorkerBinding | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const b = parsed as Record<string, unknown>;
      if (
        typeof b.assignmentId === "string" &&
        typeof b.runId === "string" &&
        typeof b.taskId === "string" &&
        typeof b.projectId === "string" &&
        typeof b.role === "string"
      ) {
        return {
          assignmentId: b.assignmentId,
          runId: b.runId,
          taskId: b.taskId,
          projectId: b.projectId,
          role: b.role,
        };
      }
    }
  } catch {
    // Fall through.
  }
  return null;
}

function parseDelegationLineage(raw: string | null): DelegationLineage | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (!isValidLineage(candidate)) return null;
    return {
      parentSessionId: candidate.parentSessionId,
      rootSessionId: candidate.rootSessionId,
      childSessionId: candidate.childSessionId,
      depth: candidate.depth,
      chain: candidate.chain,
    };
  } catch {
    return null;
  }
}

function parseDelegationSpawnRequest(raw: string | null): DelegationSpawnRequest | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.task !== "string") return null;
    return parsed as DelegationSpawnRequest;
  } catch {
    return null;
  }
}

function parseDelegationConstraints(raw: string | null): DelegationConstraints | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.maxSpawnDepth !== "number") return null;
    if (
      "maxConcurrentChildren" in candidate
      && typeof candidate.maxConcurrentChildren !== "number"
    ) return null;
    return {
      maxSpawnDepth: candidate.maxSpawnDepth,
      ...(typeof candidate.maxConcurrentChildren === "number"
        ? { maxConcurrentChildren: candidate.maxConcurrentChildren }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseEffectiveRuntime(raw: string | null): EffectiveDelegationRuntime | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.profileId !== "string") return null;
    if ("provider" in candidate && typeof candidate.provider !== "string") return null;
    if ("model" in candidate && typeof candidate.model !== "string") return null;
    return {
      profileId: candidate.profileId,
      ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
      ...(typeof candidate.model === "string" ? { model: candidate.model } : {}),
    };
  } catch {
    return null;
  }
}

function isValidLineage(candidate: Record<string, unknown>): candidate is {
  readonly parentSessionId: string;
  readonly rootSessionId: string;
  readonly childSessionId: string;
  readonly depth: number;
  readonly chain: readonly string[];
} {
  return typeof candidate.parentSessionId === "string"
    && typeof candidate.rootSessionId === "string"
    && typeof candidate.childSessionId === "string"
    && typeof candidate.depth === "number"
    && Array.isArray(candidate.chain)
    && candidate.chain.every((entry) => typeof entry === "string");
}
