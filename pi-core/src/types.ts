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
