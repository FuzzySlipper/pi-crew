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
import type {
  MessageInput,
  MessageRepository,
  MessageRow,
  SessionSearchBrowseRow,
  SessionSearchHit,
  SessionSearchRepository,
} from "./types.js";

interface SessionSearchHitRow extends MessageRow {
  readonly profile_id: string;
  readonly snippet: string;
}

interface SessionBrowseSqlRow {
  readonly session_id: string;
  readonly profile_id: string;
  readonly last_activity: string;
  readonly id: number | null;
  readonly role: MessageRow["role"] | null;
  readonly content: string | null;
  readonly tool_name: string | null;
  readonly token_count: number | null;
  readonly created_at: string | null;
}

/** SQLite-backed {@link MessageRepository}. */
export class SqliteMessageRepository implements MessageRepository, SessionSearchRepository {
  readonly #db: Database.Database;
  readonly #stmts: {
    append: Database.Statement;
    getBySession: Database.Statement;
    getRecentBySession: Database.Statement;
    count: Database.Statement;
    deleteBySession: Database.Statement;
    searchProfile: Database.Statement;
    getSessionMessagesForProfile: Database.Statement;
    getWindowBeforeForProfile: Database.Statement;
    getWindowAfterForProfile: Database.Statement;
    browseProfile: Database.Statement;
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

  searchProfile(profileId: string, query: string, limit = 5): Promise<SessionSearchHit[]> {
    const rows = this.#stmts.searchProfile.all(query, profileId, limit) as SessionSearchHitRow[];
    return Promise.resolve(rows.map((row) => ({
      profileId: row.profile_id,
      snippet: row.snippet,
      message: messageFromSearchRow(row),
    })));
  }

  getSessionMessagesForProfile(
    profileId: string,
    sessionId: string,
    limit = 500,
  ): Promise<MessageRow[]> {
    return Promise.resolve(
      this.#stmts.getSessionMessagesForProfile.all(profileId, sessionId, limit) as MessageRow[],
    );
  }

  getWindowForProfile(
    profileId: string,
    sessionId: string,
    aroundMessageId: number,
    window: number,
  ): Promise<MessageRow[]> {
    const before = this.#stmts.getWindowBeforeForProfile.all(
      profileId,
      sessionId,
      aroundMessageId,
      window + 1,
    ) as MessageRow[];
    const after = this.#stmts.getWindowAfterForProfile.all(
      profileId,
      sessionId,
      aroundMessageId,
      window,
    ) as MessageRow[];
    return Promise.resolve([...before.reverse(), ...after]);
  }

  browseProfile(profileId: string, limit = 10): Promise<SessionSearchBrowseRow[]> {
    const rows = this.#stmts.browseProfile.all(profileId, limit) as SessionBrowseSqlRow[];
    return Promise.resolve(rows.map((row) => ({
      sessionId: row.session_id,
      profileId: row.profile_id,
      lastActivity: row.last_activity,
      preview: row.id === null ? null : {
        id: row.id,
        session_id: row.session_id,
        role: row.role ?? "system",
        content: row.content ?? "",
        tool_name: row.tool_name,
        token_count: row.token_count,
        created_at: row.created_at ?? row.last_activity,
      },
    })));
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
      searchProfile: this.#db.prepare(
        `SELECT m.*, s.profile_id, snippet(messages_fts, 0, '[', ']', ' … ', 16) AS snippet
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ? AND s.profile_id = ? AND m.role IN ('user', 'assistant')
         ORDER BY bm25(messages_fts), m.id DESC
         LIMIT ?`,
      ),
      getSessionMessagesForProfile: this.#db.prepare(
        `SELECT m.* FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.profile_id = ? AND m.session_id = ?
         ORDER BY m.id ASC LIMIT ?`,
      ),
      getWindowBeforeForProfile: this.#db.prepare(
        `SELECT m.* FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.profile_id = ? AND m.session_id = ? AND m.id <= ?
         ORDER BY m.id DESC LIMIT ?`,
      ),
      getWindowAfterForProfile: this.#db.prepare(
        `SELECT m.* FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.profile_id = ? AND m.session_id = ? AND m.id > ?
         ORDER BY m.id ASC LIMIT ?`,
      ),
      browseProfile: this.#db.prepare(
        `SELECT s.id AS session_id, s.profile_id, s.last_activity,
                m.id, m.role, m.content, m.tool_name, m.token_count, m.created_at
         FROM sessions s
         LEFT JOIN messages m ON m.id = (
           SELECT mx.id FROM messages mx WHERE mx.session_id = s.id ORDER BY mx.id DESC LIMIT 1
         )
         WHERE s.profile_id = ?
         ORDER BY s.last_activity DESC LIMIT ?`,
      ),
    };
  }
}

function messageFromSearchRow(row: SessionSearchHitRow): MessageRow {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    tool_name: row.tool_name,
    token_count: row.token_count,
    created_at: row.created_at,
  };
}
