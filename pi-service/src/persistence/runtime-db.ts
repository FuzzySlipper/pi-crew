/**
 * Runtime database — SQLite connection, migration runner, and lifecycle.
 *
 * Opens a `better-sqlite3` database at the configured path in WAL mode,
 * runs forward-only idempotent migrations, validates the schema, and
 * exposes a health check.  All repository classes receive an open
 * `Database` instance from this class.
 *
 * @module pi-service/persistence/runtime-db
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "@pi-crew/core";
import type { DatabaseConfig } from "../config.js";
import type { Migration } from "./types.js";
import type { Logger } from "@pi-crew/core";

// ── Migration registry ────────────────────────────────────────────

/**
 * Ordered list of forward-only migrations.
 *
 * Each entry names an `.sql` file inside the `migrations/` directory.
 * Versions must be monotonically increasing.
 */
const MIGRATIONS: Migration[] = [
  { version: 1, name: "001_initial_schema", sql: "" },
  { version: 2, name: "002_delegation_session_columns", sql: "" },
];

// ── RuntimeDb ─────────────────────────────────────────────────────

/**
 * Manages the local SQLite runtime database.
 *
 * Responsibilities:
 *  - Open the database file (create if missing).
 *  - Enable WAL mode and foreign keys.
 *  - Run forward-only idempotent migrations.
 *  - Validate the schema after migration.
 *  - Provide health diagnostics.
 */
export class RuntimeDb {
  readonly #db: Database.Database;
  readonly #config: DatabaseConfig;
  readonly #logger: Logger;
  readonly #migrationsDir: string;

  constructor(
    config: DatabaseConfig,
    logger: Logger,
    migrationsDir?: string,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#migrationsDir = migrationsDir ?? join(dirname(fileURLToPath(import.meta.url)), "migrations");

    this.#db = this.#open();
    this.#migrate();
  }

  // ── Public API ──────────────────────────────────────────────────

  /** The underlying `better-sqlite3` Database handle. */
  get handle(): Database.Database {
    return this.#db;
  }

  /** Close the database cleanly.  Safe to call multiple times. */
  close(): void {
    try {
      this.#db.close();
      this.#logger.info("Runtime database closed");
    } catch {
      // Already closed — ignore.
    }
  }

  /** Return whether the database handle is open. */
  get isOpen(): boolean {
    try {
      this.#db.pragma("journal_mode");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Return a simple health snapshot.
   */
  health(): RuntimeDbHealth {
    return {
      path: this.#config.path,
      walEnabled: this.#db.pragma("journal_mode", { simple: true }) === "wal",
      tableCount: this.#countTables(),
      schemaVersion: this.#getSchemaVersion(),
    };
  }

  // ── Private helpers ─────────────────────────────────────────────

  #open(): Database.Database {
    const firstRun = !existsSync(this.#config.path);

    // Ensure parent directory exists.
    const dir = dirname(this.#config.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const db = new Database(this.#config.path);

    // Safety pragmas.
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    if (firstRun) {
      this.#logger.info("Created new runtime database", { path: this.#config.path });
    } else {
      this.#logger.info("Opened existing runtime database", { path: this.#config.path });
    }

    return db;
  }

  #migrate(): void {
    // Ensure schema version tracking table exists.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const current = this.#getSchemaVersion();

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;

      const sql = this.#loadMigrationSql(migration);
      this.#logger.info("Applying migration", {
        version: migration.version,
        name: migration.name,
      });

      this.#db.exec(sql);

      const now = new Date().toISOString();
      this.#db
        .prepare("INSERT INTO _schema_version (version, applied_at) VALUES (?, ?)")
        .run(migration.version, now);

      this.#logger.info("Migration applied", {
        version: migration.version,
        name: migration.name,
      });
    }

    this.#validateSchema();
  }

  #loadMigrationSql(migration: Migration): string {
    const filePath = join(this.#migrationsDir, `${migration.name}.sql`);
    if (!existsSync(filePath)) {
      throw new ConfigurationError(
        `Migration file not found: ${filePath}`,
      );
    }
    return readFileSync(filePath, "utf-8");
  }

  #validateSchema(): void {
    const tables = ["sessions", "messages", "audit_log", "runtime_kv"];
    const missing: string[] = [];

    for (const table of tables) {
      const row = this.#db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { name: string } | undefined;
      if (!row) {
        missing.push(table);
      }
    }

    if (missing.length > 0) {
      throw new ConfigurationError(
        `Runtime database is missing required tables: ${missing.join(", ")}`,
      );
    }
  }

  #getSchemaVersion(): number {
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(version), 0) as version FROM _schema_version")
      .get() as { version: number };
    return row.version;
  }

  #countTables(): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'")
      .get() as { count: number };
    return row.count;
  }
}

// ── Health type ────────────────────────────────────────────────────

/** Snapshot returned by {@link RuntimeDb.health}. */
export interface RuntimeDbHealth {
  path: string;
  walEnabled: boolean;
  tableCount: number;
  schemaVersion: number;
}
