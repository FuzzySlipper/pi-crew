/**
 * Structured logging interface consumed by every pi-crew module.
 *
 * Implementations may write to stdout, a file, or an external
 * aggregator — the contract stays the same.
 *
 * @module pi-core/logging
 */

/**
 * A key-value context bag attached to every log line.
 */
export type LogContext = Record<string, unknown>;

/**
 * Structured logger contract.
 *
 * Every method accepts a message string and an optional context object.
 * Implementations decide how to serialize and route log entries.
 */
export interface Logger {
  /**
   * Diagnostic detail useful during development and debugging.
   * Should be suppressed in production by default.
   */
  debug(message: string, context?: LogContext): void;

  /**
   * Routine operational messages (e.g. "session created", "worker claimed").
   */
  info(message: string, context?: LogContext): void;

  /**
   * Unexpected but non-fatal conditions (e.g. retry, degraded mode).
   */
  warn(message: string, context?: LogContext): void;

  /**
   * Errors that prevent an operation from completing.
   */
  error(message: string, context?: LogContext): void;
}
