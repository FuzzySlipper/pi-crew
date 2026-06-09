/**
 * SQLite-backed session repository.
 *
 * Implements the {@link SessionStore} contract from `sessions/session-store`
 * using the runtime database.  All methods return the domain
 * {@link SessionRecord} shape — row ↔ record conversion is handled
 * internally.
 *
 * @module pi-service/persistence/session-repository
 */

import type Database from "better-sqlite3";
import type { SessionRecord, SessionState } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { SessionRow, SqliteSessionStore } from "./types.js";
import { rowToRecord, recordToRow } from "./types.js";
import type { Logger } from "@pi-crew/core";
import { bindingMatchesChannel } from "../sessions/session-channel-bindings.js";

/**
 * SQLite-backed {@link SessionStore} with hydration extensions.
 */
export class SqliteSessionRepository implements SessionStore, SqliteSessionStore {
  readonly #db: Database.Database;
  readonly #logger: Logger;

  // Prepared statements (created eagerly for performance).
  readonly #stmts: {
    get: Database.Statement;
    save: Database.Statement;
    upsert: Database.Statement;
    findByState: Database.Statement;
    findByChannel: Database.Statement;
    delete: Database.Statement;
    archiveMany: Database.Statement;
  };

  constructor(db: Database.Database, logger: Logger) {
    this.#db = db;
    this.#logger = logger;
    this.#stmts = this.#prepare();
  }

  // ── SessionStore contract ───────────────────────────────────────

  get(id: string): Promise<SessionRecord | null> {
    const row = this.#stmts.get.get({ id }) as SessionRow | undefined;
    if (!row) return Promise.resolve(null);
    if (row.status === "archived") return Promise.resolve(null);
    return Promise.resolve(rowToRecord(row));
  }

  save(record: SessionRecord): Promise<SessionRecord> {
    const row = recordToRow(record);
    this.#stmts.upsert.run(row);
    this.#logger.debug("Session saved", { sessionId: record.id, state: record.state });
    return Promise.resolve(record);
  }

  findByChannel(channelId: string): Promise<SessionRecord | null> {
    // SQLite can't natively search inside a JSON array efficiently,
    // so we use LIKE as a pragmatic filter and then deserialize.
    const rows = this.#db
      .prepare(
        `SELECT * FROM sessions
         WHERE status != 'archived'
           AND channel_bindings_json LIKE @pattern ESCAPE '\\'`,
      )
      .all({ pattern: `%${this.#escapeLike(channelId)}%` }) as SessionRow[];

    for (const row of rows) {
      const record = rowToRecord(row);
      if (record.channelBindings.some((binding) => bindingMatchesChannel(binding, channelId))) {
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(null);
  }

  findByState(state: SessionState): Promise<SessionRecord[]> {
    const rows = this.#stmts.findByState.all({ status: state }) as SessionRow[];
    return Promise.resolve(rows.map(rowToRecord));
  }

  delete(id: string): Promise<void> {
    this.#stmts.delete.run({ id });
    return Promise.resolve();
  }

  // ── SqliteSessionStore extensions ──────────────────────────────

  findByStatus(status: SessionState): Promise<SessionRecord[]> {
    const rows = this.#stmts.findByState.all({ status }) as SessionRow[];
    return Promise.resolve(rows.map(rowToRecord));
  }

  archiveMany(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return Promise.resolve(0);

    const placeholders = sessionIds.map(() => "?").join(",");
    const stmt = this.#db.prepare(
      `UPDATE sessions SET status = 'archived' WHERE id IN (${placeholders})`,
    );
    const result = stmt.run(...sessionIds);
    return Promise.resolve(result.changes);
  }

  // ── Internal helpers ────────────────────────────────────────────

  #prepare() {
    return {
      get: this.#db.prepare("SELECT * FROM sessions WHERE id = @id"),
      save: this.#db.prepare(
        `INSERT INTO sessions (id, kind, profile_id, channel_bindings_json,
           worker_binding_json, delegation_json, delegation_spawn_request_json,
           delegation_constraints_json, effective_runtime_json,
           status, created_at, last_activity, expires_at)
         VALUES (@id, @kind, @profile_id, @channel_bindings_json,
                 @worker_binding_json, @delegation_json, @delegation_spawn_request_json,
                 @delegation_constraints_json, @effective_runtime_json,
                 @status, @created_at, @last_activity, @expires_at)`,
      ),
      upsert: this.#db.prepare(
        `INSERT INTO sessions (id, kind, profile_id, channel_bindings_json,
           worker_binding_json, delegation_json, delegation_spawn_request_json,
           delegation_constraints_json, effective_runtime_json,
           status, created_at, last_activity, expires_at)
         VALUES (@id, @kind, @profile_id, @channel_bindings_json,
                 @worker_binding_json, @delegation_json, @delegation_spawn_request_json,
                 @delegation_constraints_json, @effective_runtime_json,
                 @status, @created_at, @last_activity, @expires_at)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           profile_id = excluded.profile_id,
           channel_bindings_json = excluded.channel_bindings_json,
           worker_binding_json = excluded.worker_binding_json,
           delegation_json = excluded.delegation_json,
           delegation_spawn_request_json = excluded.delegation_spawn_request_json,
           delegation_constraints_json = excluded.delegation_constraints_json,
           effective_runtime_json = excluded.effective_runtime_json,
           status = excluded.status,
           last_activity = excluded.last_activity,
           expires_at = excluded.expires_at`,
      ),
      findByState: this.#db.prepare(
        "SELECT * FROM sessions WHERE status = @status",
      ),
      findByChannel: this.#db.prepare(
        `SELECT * FROM sessions
         WHERE status != 'archived'
           AND channel_bindings_json LIKE '%' || @channelId || '%'
         LIMIT 1`,
      ),
      delete: this.#db.prepare("DELETE FROM sessions WHERE id = @id"),
      archiveMany: this.#db.prepare(
        "UPDATE sessions SET status = 'archived' WHERE id = ?",
      ),
    };
  }

  #escapeLike(value: string): string {
    // Escape SQLite LIKE special characters.
    return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  }
}
