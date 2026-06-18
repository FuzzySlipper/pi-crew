/**
 * skills_list tool — list available skills with metadata.
 *
 * Equivalent to Hermes skills_list but operating on the pi-crew profile's
 * skills directory. Lists skill name, description, category, tags, version,
 * and provenance for every installed skill.
 *
 * @module pi-crew/skills-list-tool
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parseSkillFrontmatter } from "@pi-crew/core";

// ── Constants ───────────────────────────────────────────────────

const SKILL_FILE = "SKILL.md";
const ARCHIVED_DIR = ".archive";
const ARCHIVE_LABEL = "archived";

// ── Config ──────────────────────────────────────────────────────

export interface SkillsListToolInput {
  readonly skillsRoot: string;
}

export interface SkillsListFilter {
  readonly category?: string;
  readonly tag?: string;
  readonly namePrefix?: string;
  readonly includeArchived?: boolean;
}

interface SkillsListEntry {
  readonly name: string;
  readonly description: string;
  readonly category: string | undefined;
  readonly tags: readonly string[] | undefined;
  readonly version: string | undefined;
  readonly provenance: string;
  readonly dirPath: string;
}

// ── Factory ─────────────────────────────────────────────────────

export function createSkillsListTool(input: SkillsListToolInput): AgentTool {
  return {
    label: "Skills List",
    name: "skills_list",
    description:
      "List available pi-crew skills with metadata. Returns name, description, " +
      "category, tags, version, and provenance for each skill. " +
      "Optional filters: category (exact match), tag (exact), namePrefix, " +
      "includeArchived. Skills are detected by scanning the profile skills directory.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          description:
            "Optional: filter by category (exact match, case-insensitive).",
        },
        tag: {
          type: "string",
          description:
            "Optional: filter by tag (exact match, case-insensitive).",
        },
        namePrefix: {
          type: "string",
          description:
            "Optional: filter by name prefix (case-insensitive).",
        },
        includeArchived: {
          type: "boolean",
          default: false,
          description:
            "When true, also list archived skills from the .archive/ directory.",
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const filter = parseFilter(params);
      const results = await scanSkills(input.skillsRoot, filter);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ skills: results, count: results.length }, null, 2),
          },
        ],
        details: { ok: true, skills: results, count: results.length },
      };
    },
  };
}

// ── Scanning ────────────────────────────────────────────────────

async function scanSkills(
  root: string,
  filter: SkillsListFilter,
): Promise<SkillsListEntry[]> {
  const all: SkillsListEntry[] = [];

  // Scan main skills directory
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ARCHIVED_DIR) continue;
      if (entry.name === ARCHIVED_DIR) {
        if (filter.includeArchived) {
          all.push(...(await scanArchived(root, entry.name)));
        }
        continue;
      }
      const entry_ = await loadEntry(root, entry.name, "filesystem", "active");
      if (entry_) all.push(entry_);
    }
  } catch {
    // Directory doesn't exist or can't be read — empty list
    return [];
  }

  return applyFilter(all, filter);
}

async function scanArchived(
  root: string,
  archivedDir: string,
): Promise<SkillsListEntry[]> {
  const archived: SkillsListEntry[] = [];
  const archivePath = join(root, archivedDir);
  try {
    const entries = await readdir(archivePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entry_ = await loadEntry(archivePath, entry.name, "filesystem", ARCHIVE_LABEL);
      if (entry_) archived.push(entry_);
    }
  } catch {
    // Can't read archive directory — skip
  }
  return archived;
}

async function loadEntry(
  root: string,
  dirName: string,
  provenance: string,
  status: string,
): Promise<SkillsListEntry | null> {
  const skillMdPath = join(root, dirName, SKILL_FILE);
  try {
    await stat(skillMdPath);
  } catch {
    return null; // No SKILL.md — not a valid skill
  }

  // Read and parse SKILL.md
  const content = await import("node:fs/promises").then((fs) =>
    fs.readFile(skillMdPath, "utf-8"),
  ).catch(() => null);
  if (content === null) return null;

  try {
    const { frontmatter } = parseSkillFrontmatter(content);
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      category: frontmatter.category,
      tags: frontmatter.tags,
      version: frontmatter.version,
      provenance,
      dirPath: join(root, dirName),
    };
  } catch {
    // Invalid frontmatter — skip or report as partial
    return {
      name: dirName,
      description: "(invalid or missing frontmatter)",
      category: undefined,
      tags: undefined,
      version: undefined,
      provenance,
      dirPath: join(root, dirName),
    };
  }
}

// ── Filtering ───────────────────────────────────────────────────

function applyFilter(
  entries: SkillsListEntry[],
  filter: SkillsListFilter,
): SkillsListEntry[] {
  if (!filter.category && !filter.tag && !filter.namePrefix) return entries;

  return entries.filter((entry) => {
    if (filter.category) {
      if (
        !entry.category ||
        entry.category.toLowerCase() !== filter.category.toLowerCase()
      ) {
        return false;
      }
    }
    if (filter.tag) {
      if (
        !entry.tags ||
        !entry.tags.some((t) => t.toLowerCase() === filter.tag!.toLowerCase())
      ) {
        return false;
      }
    }
    if (filter.namePrefix) {
      if (
        !entry.name.toLowerCase().startsWith(filter.namePrefix.toLowerCase())
      ) {
        return false;
      }
    }
    return true;
  });
}

// ── Parameter parsing ───────────────────────────────────────────

function parseFilter(params: unknown): SkillsListFilter {
  if (typeof params !== "object" || params === null) return {};
  const record = params as Record<string, unknown>;
  return {
    category: typeof record.category === "string" && record.category.length > 0
      ? record.category
      : undefined,
    tag: typeof record.tag === "string" && record.tag.length > 0
      ? record.tag
      : undefined,
    namePrefix: typeof record.namePrefix === "string" && record.namePrefix.length > 0
      ? record.namePrefix
      : undefined,
    includeArchived: record.includeArchived === true,
  };
}
