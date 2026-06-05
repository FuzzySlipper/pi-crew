/**
 * Shared domain types for the pi-crew system.
 *
 * These are pure types with zero runtime dependencies — usable in any
 * TypeScript project that wants the pi-crew type vocabulary.
 *
 * @module pi-core/types
 */

// ── Result ─────────────────────────────────────────────────────

/**
 * A discriminated union for operations that may succeed or fail.
 *
 * Replacements for try/catch-heavy control flow. Callers inspect `ok`
 * to narrow the result before accessing `value` or `error`.
 *
 * @typeParam T - The success payload type.
 * @typeParam E - The error payload type (defaults to `Error`).
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// ── Domain identifiers ─────────────────────────────────────────

/** A project-scoped unique identifier string. */
export type ProjectId = string;

/** A task-scoped unique identifier number. */
export type TaskId = number;

/** A worker-assignment unique identifier number. */
export type AssignmentId = number;

/** A session unique identifier string. */
export type SessionId = string;

/** An agent identity string (e.g. "pi-crew-runner"). */
export type AgentIdentity = string;

/** A worker run identifier (e.g. "piw_20260605055314_f4b9fc66"). */
export type RunId = string;

// ── Timestamp ───────────────────────────────────────────────────

/** ISO-8601 timestamp string (UTC). */
export type IsoTimestamp = string;

// ── Helpers ─────────────────────────────────────────────────────

/**
 * A convenience constructor for a successful {@link Result}.
 *
 * @param value - The success value to wrap.
 * @returns A `Result` with `ok: true`.
 */
export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

/**
 * A convenience constructor for a failed {@link Result}.
 *
 * @param error - The error to wrap.
 * @returns A `Result` with `ok: false`.
 */
export function err<E, T = never>(error: E): Result<T, E> {
  return { ok: false, error };
}

// ── Worker policy ──────────────────────────────────────────────

/**
 * Bounded policy for a worker assignment.
 *
 * Enforced by the runtime — not by agent judgment. Applied at
 * instance creation and enforced at tool-execution time.
 */
export interface WorkerPolicy {
  /** Den assignment ID. */
  readonly assignmentId: string;
  /** Worker role. */
  readonly role: string;

  // Filesystem
  /** Isolated workdir for this assignment. */
  readonly workdir: string;
  /** Paths the worker can read/write. */
  readonly allowedPaths: string[];
  /** Explicitly denied paths (overrides allowedPaths). */
  readonly denyPaths: string[];

  // Tools
  /** Tool allowlist (empty = all allowed, subject to denylist). */
  readonly allowedTools: string[];
  /** Explicitly denied tool names (overrides allowlist). */
  readonly deniedTools: string[];

  // Network
  /** Domains/IPs the worker can reach (empty = all allowed). */
  readonly allowedHosts: string[];
  /** Explicitly denied hosts. */
  readonly deniedHosts: string[];

  // Time
  /** Hard timeout for the entire assignment (ms). */
  readonly maxDurationMs: number;
  /** Per-turn timeout (ms). */
  readonly maxTurnDurationMs: number;
  /** Max time between activity before considered stuck (ms). */
  readonly idleTimeoutMs: number;

  // Budget
  /** Max tool-calling loop iterations. */
  readonly maxIterations: number;
  /** Soft cap for context usage per turn. */
  readonly maxTokensPerTurn: number;

  // Credentials
  /** Credential scope for this worker. */
  readonly credentialScope: "none" | "read_only" | "bounded_write" | "full";

  // Eviction
  /** Always true for workers. */
  readonly releaseOnCompletion: boolean;
  /** Delete workdir after release. */
  readonly cleanupWorkdir: boolean;
}

// ── Drain mode ─────────────────────────────────────────────────

/**
 * Set of tool names that MUST remain available during drain mode.
 *
 * Drain mode activates when iteration/token budget is nearly
 * exhausted. Essential reporting tools are preserved; all other
 * tools are removed.
 */
export const DRAIN_MODE_ESSENTIAL_TOOLS: ReadonlySet<string> = new Set([
  "context_status",
  "post_structured_completion",
]);

/**
 * Whether drain mode is active for a session.
 */
export interface DrainModeState {
  /** Whether drain mode is currently active. */
  readonly active: boolean;
  /** Why drain mode was activated. */
  readonly reason: "iteration_budget" | "context_limit" | "timeout" | "policy";
  /** When drain mode was activated (ISO-8601). */
  readonly activatedAt: string;
}

// ── Context pressure / status ──────────────────────────────────

/**
 * Snapshot of context window usage returned by `context_status` tool.
 */
export interface ContextPressureSnapshot {
  /** Percentage of context window used (0-100). */
  readonly usagePercent: number;
  /** Estimated tokens used so far. */
  readonly tokensUsed: number;
  /** Estimated tokens remaining. */
  readonly tokensRemaining: number;
  /** Total token capacity. */
  readonly tokensTotal: number;
  /** Whether compression is imminent (usage > 70%). */
  readonly compressionImminent: boolean;
  /** Threshold percentage for compression warnings. */
  readonly compressionThreshold: number;
  /** Rough estimate of remaining turns. */
  readonly turnsRemainingEstimate: number;
  /** Human-readable recommendation. */
  readonly recommendation: string;
  /** Whether drain mode is active. */
  readonly drainActive: boolean;
}

// ── Structured completion ──────────────────────────────────────

/** Completion status values accepted by Den Core. */
export type CompletionStatus = "completed" | "failed" | "blocked" | "exhausted";

/**
 * Machine-checkable completion packet posted by workers.
 *
 * Posted to Den Core via post_structured_completion.
 * Den reconciles against assignment state.
 */
export interface CompletionPacket {
  /** Den assignment ID. */
  readonly assignmentId: string;
  /** Den worker run ID. */
  readonly runId: string;
  /** Den task ID. */
  readonly taskId: string;
  /** Completion status. */
  readonly status: CompletionStatus;

  /** Deterministic, machine-checkable artifacts produced. */
  readonly artifacts: CompletionArtifact[];

  /** Evidence of work performed. */
  readonly filesTouched: string[];
  readonly toolsUsed: string[];
  readonly tokensConsumed: number;
  readonly durationMs: number;
  readonly turnCount: number;

  /** Blocker details (required when status is "blocked"). */
  readonly blocker?: CompletionBlocker;

  /** Role that produced this packet. */
  readonly role: string;
  /** When the completion was posted (ISO-8601). */
  readonly completedAt: string;
}

/** A single artifact produced by a worker completion. */
export interface CompletionArtifact {
  /** Artifact type: "pr", "review_findings", "audit_report", etc. */
  readonly type: string;
  /** Reference: Den document ref, PR URL, commit SHA, etc. */
  readonly ref: string;
  /** Human-readable one-liner summary. */
  readonly summary: string;
}

/** Blocker information when completion status is "blocked". */
export interface CompletionBlocker {
  /** Why the worker is blocked. */
  readonly reason: string;
  /** What is needed to unblock. */
  readonly requires: "human" | "dependency" | "review";
  /** Detailed explanation. */
  readonly details: string;
}

/**
 * Result of posting a structured completion packet.
 */
export interface CompletionPostResult {
  /** Whether the post was accepted by Den. */
  readonly accepted: boolean;
  /** Den-side message/reconciliation status. */
  readonly message: string;
}
