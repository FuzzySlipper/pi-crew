/** Snapshot/rollback — recursive copy and restore of skills directory. */

import { existsSync, readdirSync, statSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "@pi-crew/core";

function copyRecursive(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true, force: true });
}

/** Snapshot the skills directory (excluding .archive, .snapshots, .curator_state). */
export function snapshot(
  skillsRoot: string,
  runId?: string,
  logger?: Logger,
): string {
  const id = runId ?? `curator-${randomUUID().slice(0, 8)}`;
  const snapDir = join(skillsRoot, ".snapshots", id, "before");
  mkdirSync(snapDir, { recursive: true });

  let entries: string[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    logger?.warn("Cannot read skills root for snapshot", { skillsRoot });
    return snapDir;
  }

  for (const name of entries) {
    const src = join(skillsRoot, name);
    const dest = join(snapDir, name);
    try {
      copyRecursive(src, dest);
    } catch (err) {
      logger?.warn("Snapshot copy failed for skill", {
        skillName: name,
        error: String(err),
      });
    }
  }

  logger?.info("Curator snapshot created", { snapDir, skillCount: entries.length });
  return snapDir;
}

/** Rollback — restore skills from a snapshot directory. */
export function rollback(
  snapshotPath: string,
  skillsRoot: string,
  logger?: Logger,
): void {
  if (!existsSync(snapshotPath)) {
    throw new Error(`Snapshot path not found: ${snapshotPath}`);
  }

  // Remove all non-system active skill dirs
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    logger?.warn("Cannot read skills root for rollback", { skillsRoot });
    return;
  }

  for (const name of entries) {
    const target = join(skillsRoot, name);
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (err) {
      logger?.warn("Failed to remove skill for rollback", {
        skillName: name,
        error: String(err),
      });
    }
  }

  // Copy snapshot contents back
  let snapEntries: string[];
  try {
    snapEntries = readdirSync(snapshotPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    logger?.warn("Cannot read snapshot directory", { snapshotPath });
    return;
  }

  for (const name of snapEntries) {
    const src = join(snapshotPath, name);
    const dest = join(skillsRoot, name);
    try {
      copyRecursive(src, dest);
    } catch (err) {
      logger?.warn("Rollback copy failed for skill", {
        skillName: name,
        error: String(err),
      });
    }
  }

  logger?.info("Curator rollback complete", { snapshotPath });
}

/** List available snapshots sorted newest first. */
export function listSnapshots(skillsRoot: string): string[] {
  const snapshotsRoot = join(skillsRoot, ".snapshots");
  if (!existsSync(snapshotsRoot)) return [];

  try {
    return readdirSync(snapshotsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Remove snapshots older than retentionDays. */
export function pruneSnapshots(
  skillsRoot: string,
  retentionDays: number,
  logger?: Logger,
): void {
  const snapshotsRoot = join(skillsRoot, ".snapshots");
  if (!existsSync(snapshotsRoot)) return;

  const now = Date.now();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  try {
    const dirs = readdirSync(snapshotsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: join(snapshotsRoot, d.name) }));

    for (const dir of dirs) {
      try {
        const mtime = statSync(dir.path).mtimeMs;
        if (mtime < cutoff) {
          rmSync(dir.path, { recursive: true, force: true });
          logger?.info("Pruned old curator snapshot", { snapshot: dir.name });
        }
      } catch {
        // skip unreadable
      }
    }
  } catch {
    logger?.warn("Failed to prune curator snapshots", { snapshotsRoot });
  }
}
