/**
 * In-memory {@link Logger} fake for testing.
 *
 * Captures every log entry with its level, message, optional context,
 * and timestamp so tests can assert on what was logged.
 *
 * @module pi-core/test-helpers/fake-logger
 */

import type { Logger, LogContext } from "../logging.js";

/**
 * A single captured log entry.
 */
export interface LogEntry {
  /** Log severity level. */
  readonly level: "debug" | "info" | "warn" | "error";
  /** The message text. */
  readonly message: string;
  /** Optional structured context. */
  readonly context?: LogContext;
  /** When the entry was recorded (wall-clock). */
  readonly timestamp: Date;
}

/**
 * In-memory {@link Logger} that records every call for test assertions.
 */
export class FakeLogger implements Logger {
  /** All captured log entries, in chronological order. */
  public readonly entries: LogEntry[] = [];

  debug(message: string, context?: LogContext): void {
    this.entries.push({
      level: "debug",
      message,
      context,
      timestamp: new Date(),
    });
  }

  info(message: string, context?: LogContext): void {
    this.entries.push({
      level: "info",
      message,
      context,
      timestamp: new Date(),
    });
  }

  warn(message: string, context?: LogContext): void {
    this.entries.push({
      level: "warn",
      message,
      context,
      timestamp: new Date(),
    });
  }

  error(message: string, context?: LogContext): void {
    this.entries.push({
      level: "error",
      message,
      context,
      timestamp: new Date(),
    });
  }

  // ── Test helpers ───────────────────────────────────────────────

  /** Remove all captured entries. */
  clear(): void {
    this.entries.length = 0;
  }
}
