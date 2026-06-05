/**
 * Session store contract — persistence for {@link SessionRecord}.
 *
 * The first implementation is in-memory (this task). Follow-up task #1866
 * provides durable local-runtime persistence.
 *
 * @module pi-service/sessions/session-store
 */

import type { SessionRecord, SessionState } from "./types.js";

// ── SessionStore interface ──────────────────────────────────────

/**
 * Repository-like contract for session-record persistence.
 *
 * Callers use this instead of a generic {@link Repository} so the store
 * can expose session-specific queries (e.g. find by channel binding).
 */
export interface SessionStore {
  /** Retrieve a session by ID (returns null for archived sessions). */
  get(id: string): Promise<SessionRecord | null>;

  /** Persist a session record (insert or upsert). */
  save(record: SessionRecord): Promise<SessionRecord>;

  /** Find the first non-archived session bound to a channel. */
  findByChannel(channelId: string): Promise<SessionRecord | null>;

  /** Find all sessions in a particular lifecycle state. */
  findByState(state: SessionState): Promise<SessionRecord[]>;

  /** Remove a session by ID. */
  delete(id: string): Promise<void>;
}

// ── InMemorySessionStore ────────────────────────────────────────

/**
 * In-memory {@link SessionStore} backed by a `Map<string, SessionRecord>`.
 *
 * Suitable for testing and the initial v1 implementation. Follow-up
 * task #1866 replaces this with a SQLite-backed store.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly store = new Map<string, SessionRecord>();

  // ── SessionStore contract ─────────────────────────────────────

  get(id: string): Promise<SessionRecord | null> {
    const record = this.store.get(id) ?? null;
    if (record?.state === "archived") return Promise.resolve(null);
    return Promise.resolve(record);
  }

  save(record: SessionRecord): Promise<SessionRecord> {
    this.store.set(record.id, record);
    return Promise.resolve(record);
  }

  findByChannel(channelId: string): Promise<SessionRecord | null> {
    for (const record of this.store.values()) {
      if (record.state === "archived") continue;
      if (record.channelBindings.includes(channelId)) {
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(null);
  }

  findByState(state: SessionState): Promise<SessionRecord[]> {
    const results: SessionRecord[] = [];
    for (const record of this.store.values()) {
      if (record.state === state) {
        results.push(record);
      }
    }
    return Promise.resolve(results);
  }

  delete(id: string): Promise<void> {
    this.store.delete(id);
    return Promise.resolve();
  }

  // ── Test helpers ──────────────────────────────────────────────

  /** Number of stored records (including archived). */
  get size(): number {
    return this.store.size;
  }

  /** Remove all records. */
  clear(): void {
    this.store.clear();
  }
}
