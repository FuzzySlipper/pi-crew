/**
 * Dense profile memory store — SQLite-backed implementation.
 *
 * Stores per-profile dense personal notes in the `profile_dense_memory` table
 * (migration 011).  On every write, also flushes to Hermes-compatible
 * filesystem files (`<profile-root>/memory.md` and `<profile-root>/user.md`).
 *
 * @module pi-service/persistence/dense-profile-memory-store
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Logger } from "@pi-crew/core";
import type {
  DenseMemoryTarget,
  DenseMemoryContent,
  DenseMemoryWriteParams,
  DenseMemoryWriteResult,
  DenseProfileMemoryStore,
} from "@pi-crew/memory";
import {
  DEFAULT_MEMORY_CAP_BYTES,
  DEFAULT_USER_CAP_BYTES,
  parseEntries,
  buildContent,
  byteLength,
  findEntryBySubstring,
  trimToCap,
} from "@pi-crew/memory";

// ── Row type ────────────────────────────────────────────────────

interface DenseMemoryRow {
  profile_id: string;
  target: string;
  content: string;
  cap_bytes: number;
  write_token: number;
  updated_at: string;
}

// ── Store implementation ────────────────────────────────────────

export class SqliteDenseProfileMemoryStore implements DenseProfileMemoryStore {
  readonly #db: Database.Database;
  readonly #logger: Logger;
  readonly #profilesRoot: string;

  constructor(
    db: Database.Database,
    logger: Logger,
    profilesRoot: string,
  ) {
    this.#db = db;
    this.#logger = logger;
    this.#profilesRoot = profilesRoot;
  }

  // ── Read ──────────────────────────────────────────────────────

  async read(profileId: string, target: DenseMemoryTarget): Promise<DenseMemoryContent> {
    const row = this.#db
      .prepare(
        "SELECT content, cap_bytes, write_token FROM profile_dense_memory WHERE profile_id = ? AND target = ?",
      )
      .get(profileId, target) as DenseMemoryRow | undefined;

    if (row === undefined) {
      // Profile+target not yet created — return empty with default caps.
      const cap = target === "user" ? DEFAULT_USER_CAP_BYTES : DEFAULT_MEMORY_CAP_BYTES;
      return {
        profileId,
        target,
        content: "",
        capBytes: cap,
        usedBytes: 0,
        writeToken: 0,
        entryCount: 0,
      };
    }

    return {
      profileId,
      target,
      content: row.content,
      capBytes: row.cap_bytes,
      usedBytes: byteLength(row.content),
      writeToken: row.write_token,
      entryCount: parseEntries(row.content).length,
    };
  }

  // ── Write ─────────────────────────────────────────────────────

  async write(params: DenseMemoryWriteParams): Promise<DenseMemoryWriteResult> {
    const { profileId, target, action, content, oldText, expectedToken } = params;

    // Read action: just return current state.
    if (action === "read") {
      const current = await this.read(profileId, target);
      return {
        success: true,
        capBytes: current.capBytes,
        usedBytes: current.usedBytes,
        newToken: current.writeToken,
        entryCount: current.entryCount,
      };
    }

    // Ensure row exists (INSERT OR IGNORE — safe for concurrent first access).
    const defaultCap = target === "user" ? DEFAULT_USER_CAP_BYTES : DEFAULT_MEMORY_CAP_BYTES;
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO profile_dense_memory (profile_id, target, content, cap_bytes, write_token, updated_at) VALUES (?, ?, '', ?, 0, datetime('now'))",
      )
      .run(profileId, target, defaultCap);

    // Read current state (within the same transaction for atomicity).
    const row = this.#db
      .prepare("SELECT content, cap_bytes, write_token FROM profile_dense_memory WHERE profile_id = ? AND target = ?")
      .get(profileId, target) as DenseMemoryRow;

    if (row === undefined) {
      // Should not happen after INSERT OR IGNORE, but guard.
      return {
        success: false,
        capBytes: defaultCap,
        usedBytes: 0,
        newToken: 0,
        driftError: "Failed to create row",
        entryCount: 0,
      };
    }

    // Drift check.
    if (expectedToken !== undefined && row.write_token !== expectedToken) {
      return {
        success: false,
        capBytes: row.cap_bytes,
        usedBytes: byteLength(row.content),
        newToken: row.write_token,
        driftError: `Write token mismatch: expected ${expectedToken}, current ${row.write_token}. Re-read and retry.`,
        entryCount: parseEntries(row.content).length,
      };
    }

    let newContent: string;
    const entries = parseEntries(row.content);

    switch (action) {
      case "add": {
        const newEntry = (content ?? "").trim();
        if (newEntry.length === 0) {
          // Empty add is a no-op — return current state.
          return {
            success: true,
            capBytes: row.cap_bytes,
            usedBytes: byteLength(row.content),
            newToken: row.write_token,
            entryCount: entries.length,
          };
        }
        const updated = [...entries, newEntry];
        const capped = trimToCap(updated, row.cap_bytes);
        newContent = buildContent(capped);
        break;
      }

      case "replace": {
        if (oldText === undefined || content === undefined) {
          return {
            success: false,
            capBytes: row.cap_bytes,
            usedBytes: byteLength(row.content),
            newToken: row.write_token,
            driftError: "replace requires both oldText and content",
            entryCount: entries.length,
          };
        }
        const idx = findEntryBySubstring(entries, oldText);
        if (idx === -1) {
          return {
            success: false,
            capBytes: row.cap_bytes,
            usedBytes: byteLength(row.content),
            newToken: row.write_token,
            driftError: `No entry found containing: ${oldText}`,
            entryCount: entries.length,
          };
        }
        entries[idx] = content.trim();
        newContent = buildContent(entries);
        break;
      }

      case "remove": {
        if (oldText === undefined) {
          return {
            success: false,
            capBytes: row.cap_bytes,
            usedBytes: byteLength(row.content),
            newToken: row.write_token,
            driftError: "remove requires oldText",
            entryCount: entries.length,
          };
        }
        const idx = findEntryBySubstring(entries, oldText);
        if (idx === -1) {
          return {
            success: false,
            capBytes: row.cap_bytes,
            usedBytes: byteLength(row.content),
            newToken: row.write_token,
            driftError: `No entry found containing: ${oldText}`,
            entryCount: entries.length,
          };
        }
        entries.splice(idx, 1);
        newContent = buildContent(entries);
        break;
      }

      default:
        return {
          success: false,
          capBytes: row.cap_bytes,
          usedBytes: byteLength(row.content),
          newToken: row.write_token,
          driftError: `Unknown action: ${action}`,
          entryCount: entries.length,
        };
    }

    // Write with token check (atomic — rows_affected will be 0 if token changed).
    const newToken = row.write_token + 1;
    const result = this.#db
      .prepare(
        "UPDATE profile_dense_memory SET content = ?, write_token = ?, updated_at = datetime('now') WHERE profile_id = ? AND target = ? AND write_token = ?",
      )
      .run(newContent, newToken, profileId, target, row.write_token);

    if (result.changes === 0) {
      // Concurrent write won the race.
      const fresh = this.#db
        .prepare("SELECT content, cap_bytes, write_token FROM profile_dense_memory WHERE profile_id = ? AND target = ?")
        .get(profileId, target) as DenseMemoryRow;
      return {
        success: false,
        capBytes: fresh.cap_bytes,
        usedBytes: byteLength(fresh.content),
        newToken: fresh.write_token,
        driftError: `Concurrent write detected. Re-read and retry.`,
        entryCount: parseEntries(fresh.content).length,
      };
    }

    const newEntries = parseEntries(newContent);

    // Best-effort filesystem export.
    try {
      this.#doExport(profileId, target, newContent);
    } catch (err) {
      // Filesystem export is best-effort — DB write already succeeded.
      // If the export fails repeatedly, operator should inspect the profile directory.
      this.#logger.warn("Dense profile memory filesystem export failed", {
        profileId,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      success: true,
      capBytes: row.cap_bytes,
      usedBytes: byteLength(newContent),
      newToken,
      entryCount: newEntries.length,
    };
  }

  // ── Filesystem export ─────────────────────────────────────────

  async exportToFilesystem(profileId: string): Promise<void> {
    for (const target of ["memory", "user"] as DenseMemoryTarget[]) {
      const content = await this.read(profileId, target);
      this.#doExport(profileId, target, content.content);
    }
  }

  async importFromFilesystem(profileId: string): Promise<void> {
    for (const target of ["memory", "user"] as DenseMemoryTarget[]) {
      const filePath = join(this.#profilesRoot, profileId, `${target}.md`);
      if (!existsSync(filePath)) continue;

      const fileContent = readFileSync(filePath, "utf-8").trim();
      if (fileContent.length === 0) continue;

      // Check DB — only import if DB is empty (fresh profile).
      const row = this.#db
        .prepare("SELECT content FROM profile_dense_memory WHERE profile_id = ? AND target = ?")
        .get(profileId, target) as DenseMemoryRow | undefined;

      if (row !== undefined && row.content.trim().length > 0) {
        // DB already has content — skip import to avoid overwrite.
        continue;
      }

      // Ensure row exists and write file content.
      const defaultCap = target === "user" ? DEFAULT_USER_CAP_BYTES : DEFAULT_MEMORY_CAP_BYTES;
      this.#db
        .prepare(
          "INSERT OR REPLACE INTO profile_dense_memory (profile_id, target, content, cap_bytes, write_token, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
        )
        .run(profileId, target, fileContent, defaultCap, 1);

      this.#logger.info("Imported dense profile memory from filesystem", {
        profileId,
        target,
        bytes: fileContent.length,
      });
    }
  }

  // ── Private helpers ───────────────────────────────────────────

  #doExport(profileId: string, target: string, content: string): void {
    const profileDir = join(this.#profilesRoot, profileId);
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
    }
    const filePath = join(profileDir, `${target}.md`);
    const tmpPath = filePath + ".tmp";

    // Atomic write: temp file + rename.
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  }
}
