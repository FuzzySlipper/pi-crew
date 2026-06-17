/** Build candidate skill list for the LLM curator pass. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@pi-crew/core";

export interface SkillCandidate {
  name: string;
  description: string;
  content: string;
  supportFiles: string[];
  provenance: string;
  daysSinceLastUpdate: number;
  contentChars: number;
}

const MIN_AGE_DAYS_DEFAULT = 1;
const SKILL_MD_MAX_CHARS = 6000;
const MAX_SUPPORT_FILES_PER_SUBDIR = 3;

const SKIP_DIRS = new Set([".archive", ".snapshots"]);

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function getLastModifiedDate(skillDir: string): Date | null {
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

/**
 * Collect up to MAX_SUPPORT_FILES_PER_SUBDIR filenames from each of
 * references/, templates/, scripts/ sub-directories inside a skill dir.
 */
function collectSupportFiles(skillDir: string): string[] {
  const results: string[] = [];

  for (const subdir of ["references", "templates", "scripts"]) {
    const subdirPath = join(skillDir, subdir);
    if (!existsSync(subdirPath)) continue;

    try {
      const entries = readdirSync(subdirPath, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => `${subdir}/${e.name}`)
        .slice(0, MAX_SUPPORT_FILES_PER_SUBDIR);
      results.push(...entries);
    } catch {
      // skip unreadable subdirs
    }
  }

  return results;
}

/**
 * Infer provenance string.
 *   - "pinned" if .pinned marker exists
 *   - "stale"  if .stale marker exists
 *   - "active" otherwise
 */
function inferProvenance(skillDir: string): string {
  if (existsSync(join(skillDir, ".pinned"))) return "pinned";
  if (existsSync(join(skillDir, ".stale"))) return "stale";
  return "active";
}

/**
 * Extract first meaningful line of SKILL.md as the description.
 */
function extractDescription(content: string): string {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      return trimmed.slice(0, 200);
    }
  }
  return "";
}

export function buildCandidateList(
  skillsRoot: string,
  now: Date,
  config: { minAgeDays: number },
  logger: Logger,
): SkillCandidate[] {
  const candidates: SkillCandidate[] = [];
  const minAge = config.minAgeDays ?? MIN_AGE_DAYS_DEFAULT;

  let entries: string[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    logger.warn("Cannot read skills root directory", { skillsRoot, error: String(err) });
    return [];
  }

  for (const name of entries) {
    // Skip special / hidden directories
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;

    const skillDir = join(skillsRoot, name);

    // Skip pinned skills
    if (isPinned(skillDir)) {
      logger.debug("Skipping pinned skill", { skillName: name });
      continue;
    }

    // Compute age
    const lastModified = getLastModifiedDate(skillDir);
    if (lastModified === null) {
      logger.debug("Cannot determine last-modified date, skipping", { skillName: name });
      continue;
    }
    const days = daysBetween(lastModified, now);

    // Skip skills that are too young
    if (days < minAge) {
      logger.debug("Skill too young, skipping", { skillName: name, daysSinceLastUpdate: days, minAgeDays: minAge });
      continue;
    }

    // Read SKILL.md
    const skillMdPath = join(skillDir, "SKILL.md");
    let content = "";
    if (existsSync(skillMdPath)) {
      try {
        content = readFileSync(skillMdPath, "utf-8").slice(0, SKILL_MD_MAX_CHARS);
      } catch (err) {
        logger.warn("Failed to read SKILL.md", { skillName: name, error: String(err) });
      }
    }

    const description = extractDescription(content);
    const supportFiles = collectSupportFiles(skillDir);

    candidates.push({
      name,
      description,
      content,
      supportFiles,
      provenance: inferProvenance(skillDir),
      daysSinceLastUpdate: days,
      contentChars: content.length,
    });
  }

  return candidates;
}
