/**
 * SQLite-backed message repository.
 *
 * Messages are scoped to a session and ordered by ascending id.
 * Content is stored as a JSON string; callers are responsible for
 * serialization/deserialization.
 *
 * @module pi-service/persistence/message-repository
 */

import type Database from "better-sqlite3";
import type { MessageInput, MessageRepository, MessageRow } from "./types.js";

/** SQLite-backed {@link MessageRepository}. */
export class SqliteMessageRepository implements MessageRepository {
  readonly #db: Database.Database;
  readonly #stmts: {
    append: Database.Statement;
    getBySession: Database.Statement;
    getRecentBySession: Database.Statement;
    count: Database.Statement;
    deleteBySession: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.#db = db;
    this.#stmts = this.#prepare();
  }

  // ── MessageRepository contract ──────────────────────────────────

  append(input: MessageInput): Promise<number> {
    const result = this.#stmts.append.run(
      input.sessionId,
      input.role,
      input.content,
      input.toolName ?? null,
      input.tokenCount ?? null,
      new Date().toISOString(),
    );
    return Promise.resolve(Number(result.lastInsertRowid));
  }

  getBySession(sessionId: string, limit = 500): Promise<MessageRow[]> {
    return Promise.resolve(this.#stmts.getBySession.all(sessionId, limit) as MessageRow[]);
  }

  getRecentBySession(sessionId: string, limit = 500): Promise<MessageRow[]> {
    const rows = this.#stmts.getRecentBySession.all(sessionId, limit) as MessageRow[];
    return Promise.resolve(rows.reverse());
  }

  count(sessionId: string): Promise<number> {
    const row = this.#stmts.count.get(sessionId) as { cnt: number } | undefined;
    return Promise.resolve(row?.cnt ?? 0);
  }

  deleteBySession(sessionId: string): Promise<void> {
    this.#stmts.deleteBySession.run(sessionId);
    return Promise.resolve();
  }

  // ── Internal ────────────────────────────────────────────────────

  #prepare() {
    return {
      append: this.#db.prepare(
        `INSERT INTO messages (session_id, role, content, tool_name, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      getBySession: this.#db.prepare(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?`,
      ),
      getRecentBySession: this.#db.prepare(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      ),
      count: this.#db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?"),
      deleteBySession: this.#db.prepare("DELETE FROM messages WHERE session_id = ?"),
    };
  }
}
