/** Archive management + pin support — move skills to/from .archive, pin/unpin. */

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import type { Logger } from "@pi-crew/core";
import type { ArchivedSkill } from "./types.js";

function archiveDir(skillsRoot: string): string {
  return join(skillsRoot, ".archive");
}

function archivedPath(skillsRoot: string, name: string): string {
  return join(archiveDir(skillsRoot), name);
}

function activePath(skillsRoot: string, name: string): string {
  return join(skillsRoot, name);
}

/** Archive a skill — move from skillsRoot/name to skillsRoot/.archive/name/. */
export function archiveSkill(
  skillsRoot: string,
  skillName: string,
  logger?: Logger,
): void {
  const src = activePath(skillsRoot, skillName);
  if (!existsSync(src)) {
    throw new Error(`Skill not found: ${skillName} at ${src}`);
  }

  const dest = archivedPath(skillsRoot, skillName);
  if (existsSync(dest)) {
    throw new Error(`Skill already archived: ${skillName}`);
  }

  const archiveRoot = archiveDir(skillsRoot);
  if (!existsSync(archiveRoot)) {
    mkdirSync(archiveRoot, { recursive: true });
  }

  renameSync(src, dest);
  writeFileSync(join(dest, ".archived_at"), new Date().toISOString(), "utf-8");
  logger?.info("Skill archived", { skillName });
}

/** List all archived skills. */
export function listArchived(skillsRoot: string): ArchivedSkill[] {
  const dir = archiveDir(skillsRoot);
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const name = d.name;
        let archivedAt = "";
        try {
          const marker = join(dir, name, ".archived_at");
          if (existsSync(marker)) {
            archivedAt = readFileSync(marker, "utf-8").trim();
          }
        } catch {
          // ignore
        }
        return {
          name,
          archivedAt,
          originalPath: join(dir, name),
        };
      });
  } catch {
    return [];
  }
}

/** Restore an archived skill — move from .archive/name back to skillsRoot/name. */
export function restoreSkill(
  skillsRoot: string,
  skillName: string,
  logger?: Logger,
): void {
  const src = archivedPath(skillsRoot, skillName);
  if (!existsSync(src)) {
    throw new Error(`Archived skill not found: ${skillName}`);
  }

  const dest = activePath(skillsRoot, skillName);
  if (existsSync(dest)) {
    throw new Error(`Active skill already exists: ${skillName}. Remove or rename it first.`);
  }

  renameSync(src, dest);
  logger?.info("Skill restored from archive", { skillName });
}

/** Pin a skill — create .pinned marker file. */
export function pinSkill(
  skillsRoot: string,
  skillName: string,
  logger?: Logger,
): void {
  const dir = activePath(skillsRoot, skillName);
  if (!existsSync(dir)) {
    throw new Error(`Skill not found: ${skillName}`);
  }
  writeFileSync(join(dir, ".pinned"), "", "utf-8");
  logger?.info("Skill pinned", { skillName });
}

/** Unpin a skill — remove .pinned marker file. */
export function unpinSkill(
  skillsRoot: string,
  skillName: string,
  logger?: Logger,
): void {
  const dir = activePath(skillsRoot, skillName);
  if (!existsSync(dir)) {
    throw new Error(`Skill not found: ${skillName}`);
  }
  const marker = join(dir, ".pinned");
  if (existsSync(marker)) {
    rmSync(marker);
    logger?.info("Skill unpinned", { skillName });
  }
}

/** Non-async version of unpin for sync contexts */
export function unpinSkillSync(skillsRoot: string, skillName: string): void {
  const dir = activePath(skillsRoot, skillName);
  if (!existsSync(dir)) return;
  const marker = join(dir, ".pinned");
  if (existsSync(marker)) {
    rmSync(marker);
  }
}

/** List all pinned skills across active and archive directories. */
export function listPinned(skillsRoot: string): string[] {
  const result: string[] = [];

  // Check active skills
  try {
    const active = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
    for (const name of active) {
      if (existsSync(join(skillsRoot, name, ".pinned"))) {
        result.push(name);
      }
    }
  } catch {
    // ignore
  }

  return result;
}

/** Check if a specific skill (in active root or archive) is pinned. */
export function isPinned(skillsRoot: string, skillName: string): boolean {
  const active = join(skillsRoot, skillName, ".pinned");
  if (existsSync(active)) return true;
  const archived = join(archiveDir(skillsRoot), skillName, ".pinned");
  if (existsSync(archived)) return true;
  return false;
}
