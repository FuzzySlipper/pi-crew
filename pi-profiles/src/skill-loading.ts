/** Filesystem skill resolution for pi-crew profiles. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigurationError, parseSkillFrontmatter } from "@pi-crew/core";
import type { Skill } from "./profile.js";

export type RawSkillSelection = "all" | readonly string[] | readonly Record<string, unknown>[];

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_CONTENT_CHARS = 6_000;

export interface ResolveProfileSkillsInput {
  readonly profileId: string;
  readonly raw: unknown;
  readonly globalSkillsDir: string;
  readonly profileSkillsDir?: string;
}

interface FilesystemSkill {
  readonly skill: Skill;
  readonly sourceRank: number;
}

export function resolveProfileSkills(input: ResolveProfileSkillsInput): Skill[] {
  const raw = input.raw;
  if (raw === undefined || raw === null) return [];
  if (raw === "all") return selectAllSkills(input);
  if (!Array.isArray(raw)) {
    throw new ConfigurationError(
      `Profile "${input.profileId}" field "skills" must be "all" or an array`,
    );
  }
  if (raw.every((entry) => typeof entry === "string")) {
    return selectNamedSkills(input, raw);
  }
  return raw.map((item, index) => parseInlineSkill(item, input.profileId, index));
}

function selectAllSkills(input: ResolveProfileSkillsInput): Skill[] {
  return [...loadAvailableSkills(input).values()]
    .sort((left, right) => left.skill.name.localeCompare(right.skill.name))
    .map((entry) => entry.skill);
}

function selectNamedSkills(input: ResolveProfileSkillsInput, names: readonly string[]): Skill[] {
  const available = loadAvailableSkills(input);
  return names.map((name) => {
    const skill = available.get(name)?.skill;
    if (skill === undefined) {
      throw new ConfigurationError(
        `Profile "${input.profileId}" requested missing skill "${name}"`,
      );
    }
    return skill;
  });
}

function loadAvailableSkills(input: ResolveProfileSkillsInput): Map<string, FilesystemSkill> {
  const skills = new Map<string, FilesystemSkill>();
  loadSkillDir(input.globalSkillsDir, 0, skills);
  if (input.profileSkillsDir !== undefined) {
    loadSkillDir(input.profileSkillsDir, 1, skills);
  }
  return skills;
}

function loadSkillDir(
  skillsDir: string,
  sourceRank: number,
  skills: Map<string, FilesystemSkill>,
): void {
  if (!existsSync(skillsDir)) return;
  const entries = readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillsDir, entry.name, SKILL_FILE);
    if (!existsSync(skillPath)) continue;
    const loaded = parseFilesystemSkill(skillPath, sourceRank);
    const current = skills.get(loaded.skill.name);
    if (current === undefined || loaded.sourceRank >= current.sourceRank) {
      skills.set(loaded.skill.name, loaded);
    }
  }
}

function parseFilesystemSkill(skillPath: string, sourceRank: number): FilesystemSkill {
  const content = readFileSync(skillPath, "utf-8");
  try {
    const parsed = parseSkillFrontmatter(content);
    return {
      sourceRank,
      skill: {
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        version: parsed.frontmatter.version ?? "0.1.0",
        content: boundSkillBody(parsed.body),
        sourcePath: skillPath,
      },
    };
  } catch (cause) {
    throw new ConfigurationError(`Cannot parse skill at "${skillPath}": ${String(cause)}`);
  }
}

function boundSkillBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_SKILL_CONTENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SKILL_CONTENT_CHARS)}\n\n[skill content truncated]`;
}

function parseInlineSkill(item: unknown, profileId: string, index: number): Skill {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new ConfigurationError(
      `Profile "${profileId}" skill[${String(index)}] must be an object or skill name`,
    );
  }
  const s = item as Record<string, unknown>;
  const name = typeof s["name"] === "string" ? s["name"] : undefined;
  const description = typeof s["description"] === "string" ? s["description"] : "";
  const version = typeof s["version"] === "string" ? s["version"] : "0.1.0";
  if (name === undefined || name.trim() === "") {
    throw new ConfigurationError(
      `Profile "${profileId}" skill[${String(index)}] is missing required field "name"`,
    );
  }
  return { name, description, version };
}
