/** Auto-transition logic — active → stale → archived, pure filesystem. */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import type { Logger } from "@pi-crew/core";
import type { AutoTransition } from "./types.js";

const STALE_MARKER = ".stale";

function daysSince(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function lastUsedDate(skillDir: string): Date | null {
  const lastUsedPath = join(skillDir, ".last_used");
  if (existsSync(lastUsedPath)) {
    try {
      const raw = readFileSync(lastUsedPath, "utf-8").trim();
      const parsed = new Date(raw);
      if (!isNaN(parsed.getTime())) return parsed;
    } catch {
      // fall through to mtime
    }
  }
  try {
    return statSync(skillDir).mtime;
  } catch {
    return null;
  }
}

function isPinned(skillDir: string): boolean {
  return existsSync(join(skillDir, ".pinned"));
}

export function applyAutoTransitions(
  skillsRoot: string,
  now: Date,
  config: { staleAfterDays: number; archiveAfterDays: number },
  logger: Logger,
): AutoTransition[] {
  const transitions: AutoTransition[] = [];
  let entries: string[];

  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    logger.warn("Cannot read skills root directory for auto-transitions", { skillsRoot });
    return [];
  }

  const archiveDir = join(skillsRoot, ".archive");

  for (const name of entries) {
    if (name.startsWith(".")) continue;

    const skillDir = join(skillsRoot, name);

    // Skip if pinned
    if (isPinned(skillDir)) continue;

    const lastUsed = lastUsedDate(skillDir);
    if (lastUsed === null) continue;

    const days = daysSince(lastUsed, now);
    const isCurrentlyStale = existsSync(join(skillDir, STALE_MARKER));

    // active → stale
    if (days >= config.staleAfterDays && !isCurrentlyStale && days < config.archiveAfterDays) {
      try {
        writeFileSync(join(skillDir, STALE_MARKER), new Date().toISOString(), "utf-8");
        transitions.push({ type: "stale", skillName: name, daysSinceLastUse: days });
        logger.info("Auto-transition: active → stale", { skillName: name, days });
      } catch (err) {
        logger.warn("Failed to mark skill stale", { skillName: name, error: String(err) });
      }
    }

    // stale → archived
    if (isCurrentlyStale && days >= config.archiveAfterDays) {
      try {
        if (!existsSync(archiveDir)) {
          mkdirSync(archiveDir, { recursive: true });
        }
        renameSync(skillDir, join(archiveDir, name));
        writeFileSync(join(archiveDir, name, ".archived_at"), new Date().toISOString(), "utf-8");
        transitions.push({ type: "archived", skillName: name, daysSinceLastUse: days });
        logger.info("Auto-transition: stale → archived", { skillName: name, days });
      } catch (err) {
        logger.warn("Failed to archive skill", { skillName: name, error: String(err) });
      }
    }

    // stale → reactivated
    if (days < config.staleAfterDays && isCurrentlyStale) {
      try {
        rmSync(join(skillDir, STALE_MARKER));
        transitions.push({ type: "reactivated", skillName: name, daysSinceLastUse: days });
        logger.info("Auto-transition: stale → reactivated", { skillName: name, days });
      } catch (err) {
        logger.warn("Failed to reactivate skill", { skillName: name, error: String(err) });
      }
    }
  }

  return transitions;
}
