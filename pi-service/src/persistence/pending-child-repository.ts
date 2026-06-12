/** SQLite-backed pending delegated child repository. */

import type Database from "better-sqlite3";
import type { DelegationLineage, EffectiveDelegationRuntime } from "@pi-crew/core";
import type {
  PendingChildRecord,
  PendingChildRepository,
  PendingChildStatus,
} from "../workers/delegated-child-registry.js";

interface PendingChildRow {
  readonly child_session_id: string;
  readonly parent_session_id: string;
  readonly root_session_id: string;
  readonly lineage_json: string;
  readonly status: string;
  readonly spawned_at: string;
  readonly updated_at: string;
  readonly timeout_ms: number | null;
  readonly policy_id: string;
  readonly effective_runtime_json: string;
  readonly latest_event_id: string | null;
  readonly latest_checkpoint_id: string | null;
  readonly outcome: string | null;
}

export class SqlitePendingChildRepository implements PendingChildRepository {
  readonly #db: Database.Database;
  readonly #upsert: Database.Statement;
  readonly #get: Database.Statement;
  readonly #listActive: Database.Statement;
  readonly #listAll: Database.Statement;
  readonly #deleteOlderThan: Database.Statement;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#ensureTable();
    this.#upsert = this.#db.prepare(`
      INSERT INTO pending_delegated_children(
        child_session_id, parent_session_id, root_session_id, lineage_json,
        status, spawned_at, updated_at, timeout_ms, policy_id,
        effective_runtime_json, latest_event_id, latest_checkpoint_id, outcome
      ) VALUES (
        @childSessionId, @parentSessionId, @rootSessionId, @lineageJson,
        @status, @spawnedAt, @updatedAt, @timeoutMs, @policyId,
        @effectiveRuntimeJson, @latestEventId, @latestCheckpointId, @outcome
      )
      ON CONFLICT(child_session_id) DO UPDATE SET
        parent_session_id=excluded.parent_session_id,
        root_session_id=excluded.root_session_id,
        lineage_json=excluded.lineage_json,
        status=excluded.status,
        spawned_at=excluded.spawned_at,
        updated_at=excluded.updated_at,
        timeout_ms=excluded.timeout_ms,
        policy_id=excluded.policy_id,
        effective_runtime_json=excluded.effective_runtime_json,
        latest_event_id=COALESCE(excluded.latest_event_id, pending_delegated_children.latest_event_id),
        latest_checkpoint_id=COALESCE(excluded.latest_checkpoint_id, pending_delegated_children.latest_checkpoint_id),
        outcome=excluded.outcome
    `);
    this.#get = this.#db.prepare("SELECT * FROM pending_delegated_children WHERE child_session_id = ?");
    this.#listActive = this.#db.prepare("SELECT * FROM pending_delegated_children WHERE status = 'active' ORDER BY spawned_at ASC");
    this.#listAll = this.#db.prepare("SELECT * FROM pending_delegated_children ORDER BY spawned_at ASC");
    this.#deleteOlderThan = this.#db.prepare("DELETE FROM pending_delegated_children WHERE updated_at < ?");
  }

  upsert(record: PendingChildRecord): Promise<void> {
    this.#upsert.run(toParams(record));
    return Promise.resolve();
  }

  get(childSessionId: string): Promise<PendingChildRecord | null> {
    const row = this.#get.get(childSessionId) as PendingChildRow | undefined;
    return Promise.resolve(row === undefined ? null : fromRow(row));
  }

  listActive(): Promise<readonly PendingChildRecord[]> {
    return Promise.resolve((this.#listActive.all() as PendingChildRow[]).map(fromRow));
  }

  listAll(): Promise<readonly PendingChildRecord[]> {
    return Promise.resolve((this.#listAll.all() as PendingChildRow[]).map(fromRow));
  }

  deleteOlderThan(cutoffIso: string): Promise<number> {
    const result = this.#deleteOlderThan.run(cutoffIso);
    return Promise.resolve(result.changes);
  }

  #ensureTable(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS pending_delegated_children (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        root_session_id TEXT NOT NULL,
        lineage_json TEXT NOT NULL,
        status TEXT NOT NULL,
        spawned_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        timeout_ms INTEGER,
        policy_id TEXT NOT NULL,
        effective_runtime_json TEXT NOT NULL,
        latest_event_id TEXT,
        latest_checkpoint_id TEXT,
        outcome TEXT
      )
    `);
  }
}

function toParams(record: PendingChildRecord): Readonly<Record<string, unknown>> {
  return {
    childSessionId: record.childSessionId,
    parentSessionId: record.parentSessionId,
    rootSessionId: record.rootSessionId,
    lineageJson: JSON.stringify(record.lineage),
    status: record.status,
    spawnedAt: record.spawnedAt,
    updatedAt: record.updatedAt,
    timeoutMs: record.timeoutMs ?? null,
    policyId: record.policyId,
    effectiveRuntimeJson: JSON.stringify(record.effectiveRuntime),
    latestEventId: record.latestEventId ?? null,
    latestCheckpointId: record.latestCheckpointId ?? null,
    outcome: record.outcome ?? null,
  };
}

function fromRow(row: PendingChildRow): PendingChildRecord {
  return {
    childSessionId: row.child_session_id,
    parentSessionId: row.parent_session_id,
    rootSessionId: row.root_session_id,
    lineage: JSON.parse(row.lineage_json) as DelegationLineage,
    status: row.status as PendingChildStatus,
    spawnedAt: row.spawned_at,
    updatedAt: row.updated_at,
    timeoutMs: row.timeout_ms ?? undefined,
    policyId: row.policy_id,
    effectiveRuntime: JSON.parse(row.effective_runtime_json) as EffectiveDelegationRuntime,
    latestEventId: row.latest_event_id ?? undefined,
    latestCheckpointId: row.latest_checkpoint_id ?? undefined,
    outcome: row.outcome as PendingChildRecord["outcome"],
  };
}
