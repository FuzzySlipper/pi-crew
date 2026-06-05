/**
 * SQLite-backed audit repository with deterministic secret redaction.
 *
 * Audit events carry Den correlation IDs (assignment_id, run_id) and
 * are flushed to Den in batches.  Redaction happens at the storage
 * boundary — before data is written to the `audit_log` table.
 *
 * @module pi-service/persistence/audit-repository
 */

import type Database from "better-sqlite3";
import type { AuditEventInput, AuditRepository, AuditRow } from "./types.js";

// ── Redaction patterns ────────────────────────────────────────────

/**
 * Deterministic secret redaction applied to event_data at the storage
 * boundary.  Never relies on LLM guidance — this runs mechanically
 * before any durable write.
 */
const REDACTION_KEYWORDS = [
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /authorization\s*[:=]\s*\S+/gi,
  /bearer\s+\S+/gi,
  /(?<=(["']))(sk-[a-zA-Z0-9.]{8,})(?=\1)/g,
  /\bsk-[a-zA-Z0-9.]{8,}/g,
  /x-api-key\s*[:=]\s*\S+/gi,
  /token\s*[:=]\s*\S+/gi,
  /secret\s*[:=]\s*\S+/gi,
  /password\s*[:=]\s*\S+/gi,
];

const REDACTED_PLACEHOLDER = "[REDACTED]";
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|cookie|password|secret|token)/i;

/**
 * Apply deterministic redaction to event payloads before durable storage.
 */
function redactEventData(data: Record<string, unknown>): string {
  const redacted = redactValue(data, null);
  let result = JSON.stringify(redacted);
  for (const pattern of REDACTION_KEYWORDS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return result;
}

function redactValue(value: unknown, key: string | null): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) return REDACTED_PLACEHOLDER;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, null));
  if (value && typeof value === "object") return redactObject(value);
  return value;
}

function redactObject(value: object): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = redactValue(entryValue, entryKey);
  }
  return output;
}

function redactString(value: string): string {
  let result = value;
  for (const pattern of REDACTION_KEYWORDS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return result;
}

// ── SqliteAuditRepository ─────────────────────────────────────────

/** SQLite-backed {@link AuditRepository}. */
export class SqliteAuditRepository implements AuditRepository {
  readonly #db: Database.Database;
  readonly #stmts: {
    write: Database.Statement;
    getPending: Database.Statement;
    markFlushed: Database.Statement;
    pruneOlderThan: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.#db = db;
    this.#stmts = this.#prepare();
  }

  // ── AuditRepository contract ────────────────────────────────────

  write(input: AuditEventInput): Promise<number> {
    const redacted = redactEventData(input.eventData);
    const result = this.#stmts.write.run(
      input.sessionId ?? null,
      input.assignmentId ?? null,
      input.runId ?? null,
      input.eventType,
      redacted,
      new Date().toISOString(),
    );
    return Promise.resolve(Number(result.lastInsertRowid));
  }

  getPending(limit = 100): Promise<AuditRow[]> {
    return Promise.resolve(this.#stmts.getPending.all(limit) as AuditRow[]);
  }

  markFlushed(ids: number[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();

    const placeholders = ids.map(() => "?").join(",");
    const stmt = this.#db.prepare(
      `UPDATE audit_log SET flushed = 1 WHERE id IN (${placeholders})`,
    );
    stmt.run(...ids);
    return Promise.resolve();
  }

  pruneOlderThan(cutoff: string): Promise<number> {
    const result = this.#stmts.pruneOlderThan.run(cutoff);
    return Promise.resolve(result.changes);
  }

  // ── Internal ────────────────────────────────────────────────────

  #prepare() {
    return {
      write: this.#db.prepare(
        `INSERT INTO audit_log (session_id, assignment_id, run_id, event_type, event_data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      getPending: this.#db.prepare(
        "SELECT * FROM audit_log WHERE flushed = 0 ORDER BY id ASC LIMIT ?",
      ),
      markFlushed: this.#db.prepare(
        "UPDATE audit_log SET flushed = 1 WHERE id = ?",
      ),
      pruneOlderThan: this.#db.prepare(
        "DELETE FROM audit_log WHERE created_at < ?",
      ),
    };
  }
}
