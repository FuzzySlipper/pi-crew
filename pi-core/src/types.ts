/**
 * Shared domain types for the pi-crew system.
 *
 * These are pure types with zero runtime dependencies — usable in any
 * TypeScript project that wants the pi-crew type vocabulary.
 *
 * @module pi-core/types
 */

import type { ExecutionPolicy } from "./security.js";

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
 * Worker-specific metadata layered on generic execution constraints.
 *
 * The execution constraints live on {@link ExecutionPolicy}. WorkerPolicy
 * adds Den assignment identity and worker lifecycle controls.
 */
export interface WorkerPolicy extends ExecutionPolicy {
  /** Den assignment ID. Maps to policyId for worker sessions. */
  readonly assignmentId: string;
  /** Worker role. */
  readonly role: string;
  /** Isolated workdir for this assignment. Mirrors rootPath for compatibility. */
  readonly workdir: string;
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
