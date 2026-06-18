/**
 * skill_manage tool — CRUD operations on pi-crew profile skills.
 *
 * Provides create, patch, write_file, and delete operations for skills
 * in the profile's skills directory. Mirrors the Hermes skill_manage
 * tool semantics: frontmatter + markdown body skills, pinned protection,
 * provenance awareness, and absorbed_into semantics for deletion.
 *
 * @module pi-crew/skill-manage-tool
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parseSkillFrontmatter } from "@pi-crew/core";

// ── Constants ───────────────────────────────────────────────────

const SKILL_FILE = "SKILL.md";
const LINKED_SUBDIRS = ["references", "templates", "scripts", "assets"] as const;
const ARCHIVED_DIR = ".archive";

const ACTIONS = ["create", "patch", "write_file", "delete"] as const;
type SkillManageAction = (typeof ACTIONS)[number];

// ── Config ──────────────────────────────────────────────────────

export interface SkillManageToolInput {
  readonly skillsRoot: string;
}

// ── Factory ─────────────────────────────────────────────────────

export function createSkillManageTool(input: SkillManageToolInput): AgentTool {
  return {
    label: "Skill Manage",
    name: "skill_manage",
    description:
      "Manage pi-crew skills in the profile's skills directory. " +
      "Actions: create (new SKILL.md), patch (find-and-replace in SKILL.md), " +
      "write_file (add/update support files), delete (remove skill directory). " +
      "Pinned skills (directory with .pinned marker) reject delete. " +
      "Use absorbed_into on delete to forward consolidation intent. " +
      "Set dryRun=true for a preview without side effects.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description:
            "'create' creates a new skill directory with SKILL.md. " +
            "'patch' finds and replaces text in an existing SKILL.md. " +
            "'write_file' updates a support file (references/*, templates/*, scripts/*). " +
            "'delete' removes a skill directory (requires absorbed_into for consolidation).",
        },
        name: {
          type: "string",
          description:
            "Skill name (directory name, kebab-case recommended). " +
            "Required for all actions.",
        },
        content: {
          type: "string",
          description:
            "Full SKILL.md content (YAML frontmatter + markdown body). " +
            "Required for 'create'. Optional for 'patch' (use old_string/new_string instead).",
        },
        old_string: {
          type: "string",
          description:
            "Text to find and replace in SKILL.md (for 'patch' action). " +
            "Must be unique in the file. Include surrounding context for uniqueness.",
        },
        new_string: {
          type: "string",
          description:
            "Replacement text for 'patch' action. Can be empty string to delete matched text.",
        },
        file_path: {
          type: "string",
          description:
            "Path within the skill directory for 'write_file' action. " +
            "Must be under references/, templates/, scripts/, or assets/. " +
            "Example: 'references/api.md' or 'templates/config.yaml'.",
        },
        file_content: {
          type: "string",
          description:
            "Content for the file (required for 'write_file' action).",
        },
        absorbed_into: {
          type: "string",
          description:
            "Required for 'delete' action — the target skill name this " +
            "skill's content is being consolidated into. Pass empty string " +
            "when pruning with no forwarding target.",
        },
        dryRun: {
          type: "boolean",
          default: false,
          description:
            "When true, preview the operation without side effects.",
        },
      },
      required: ["action", "name"],
    },
    execute: async (_toolCallId, params) => {
      const action = parseAction(params);
      if (action === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid action. Must be one of: ${ACTIONS.join(", ")}`,
            },
          ],
          details: { ok: false, error: "invalid_action" },
        };
      }

      const name = parseName(params);
      if (name === undefined) {
        return {
          content: [{ type: "text", text: 'Missing required parameter: "name".' }],
          details: { ok: false, error: "missing_name" },
        };
      }

      const dryRun = parseDryRun(params);

      try {
        switch (action) {
          case "create":
            return await handleCreate(input.skillsRoot, name, params, dryRun);
          case "patch":
            return await handlePatch(input.skillsRoot, name, params, dryRun);
          case "write_file":
            return await handleWriteFile(input.skillsRoot, name, params, dryRun);
          case "delete":
            return await handleDelete(input.skillsRoot, name, params, dryRun);
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Skill "${action}" for "${name}" failed: ${String(err)}`,
            },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  };
}

// ── Action handlers ─────────────────────────────────────────────

async function handleCreate(
  skillsRoot: string,
  name: string,
  params: unknown,
  dryRun: boolean,
): Promise<AgentTool["execute"] extends (id: string, params: unknown) => infer R ? R : never> {
  const content = parseStringParam(params, "content");
  if (content === undefined) {
    return simpleResult("Missing required parameter: content", { error: "missing_content" });
  }

  // Validate frontmatter
  try {
    parseSkillFrontmatter(content);
  } catch (err) {
    return simpleResult(`Invalid SKILL.md frontmatter: ${String(err)}`, { error: "invalid_frontmatter" });
  }

  const skillDir = join(skillsRoot, name);

  if (dryRun) {
    return simpleResult(
      `Preview: Would create skill "${name}" at ${skillDir}/SKILL.md`,
      { action: "create", name, dryRun: true },
    );
  }

  // Create directory and write SKILL.md
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, SKILL_FILE), content, "utf-8");

  return simpleResult(`Created skill "${name}" at ${skillDir}/SKILL.md`, {
    ok: true,
    action: "create",
    name,
    dirPath: skillDir,
  });
}

async function handlePatch(
  skillsRoot: string,
  name: string,
  params: unknown,
  dryRun: boolean,
): Promise<ReturnType<typeof simpleResult>> {
  const skillDir = join(skillsRoot, name);
  const skillMdPath = join(skillDir, SKILL_FILE);

  // Read existing SKILL.md
  let existing: string;
  try {
    existing = await readFile(skillMdPath, "utf-8");
  } catch {
    return simpleResult(
      `Skill "${name}" not found — SKILL.md not found at ${skillMdPath}`,
      { error: "not_found" },
    );
  }

  const oldString = parseStringParam(params, "old_string");
  const newString = parseStringParam(params, "new_string") ?? "";
  const fullContent = parseStringParam(params, "content");

  let newContent: string;

  if (fullContent !== undefined) {
    // Full overwrite
    newContent = fullContent;
  } else if (oldString !== undefined) {
    // Find-and-replace
    if (!existing.includes(oldString)) {
      return simpleResult(
        `old_string not found in SKILL.md for "${name}". The text must match exactly.`,
        { error: "old_string_not_found" },
      );
    }
    newContent = existing.replace(oldString, newString);
    if (newContent === existing) {
      return simpleResult(
        `No changes made: old_string matched but replacement produced identical content for "${name}".`,
        { details: { action: "patch", name, unchanged: true } },
      );
    }
  } else {
    return simpleResult(
      'Provide either "content" (full overwrite) or "old_string" + "new_string" (find-and-replace) for patch.',
      { error: "missing_content_or_old_string" },
    );
  }

  // For full overwrite, validate frontmatter
  if (fullContent !== undefined) {
    try {
      parseSkillFrontmatter(fullContent);
    } catch (err) {
      return simpleResult(`Invalid SKILL.md frontmatter: ${String(err)}`, { error: "invalid_frontmatter" });
    }
  }

  if (dryRun) {
    return simpleResult(
      `Preview: Would patch SKILL.md for skill "${name}"`,
      { action: "patch", name, dryRun: true },
    );
  }

  await writeFile(skillMdPath, newContent, "utf-8");

  return simpleResult(`Patched SKILL.md for skill "${name}"`, {
    ok: true,
    action: "patch",
    name,
  });
}

async function handleWriteFile(
  skillsRoot: string,
  name: string,
  params: unknown,
  dryRun: boolean,
): Promise<ReturnType<typeof simpleResult>> {
  const filePath = parseStringParam(params, "file_path");
  const fileContent = parseStringParam(params, "file_content");

  if (filePath === undefined) {
    return simpleResult('Missing required parameter: "file_path".', { error: "missing_file_path" });
  }
  if (fileContent === undefined) {
    return simpleResult('Missing required parameter: "file_content".', { error: "missing_file_content" });
  }

  // Validate file_path is in an allowed subdirectory
  const allowed = LINKED_SUBDIRS.some((subdir) =>
    filePath.startsWith(`${subdir}/`) || filePath.startsWith(`${subdir}/`),
  );
  if (!allowed) {
    return simpleResult(
      `file_path must be under one of: ${LINKED_SUBDIRS.join(", ")}. Got: ${filePath}`,
      { error: "invalid_file_path" },
    );
  }

  const skillDir = join(skillsRoot, name);
  const absPath = join(skillDir, filePath);

  if (dryRun) {
    return simpleResult(
      `Preview: Would write "${filePath}" for skill "${name}"`,
      { action: "write_file", name, filePath, dryRun: true },
    );
  }

  // Ensure parent directory exists
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, fileContent, "utf-8");

  return simpleResult(`Wrote "${filePath}" for skill "${name}"`, {
    ok: true,
    action: "write_file",
    name,
    filePath,
  });
}

async function handleDelete(
  skillsRoot: string,
  name: string,
  params: unknown,
  dryRun: boolean,
): Promise<ReturnType<typeof simpleResult>> {
  const absorbedInto = parseStringParam(params, "absorbed_into");

  if (absorbedInto === undefined) {
    return simpleResult(
      '"absorbed_into" is required for delete action. ' +
      'Pass the umbrella skill name when consolidating, or empty string when pruning.',
      { error: "missing_absorbed_into" },
    );
  }

  const skillDir = join(skillsRoot, name);

  // Check if skill exists
  try {
    await readFile(join(skillDir, SKILL_FILE), "utf-8");
  } catch {
    return simpleResult(`Skill "${name}" not found at ${skillDir}`, { error: "not_found" });
  }

  // Check for pinned marker
  try {
    await readFile(join(skillDir, ".pinned"), "utf-8");
    return simpleResult(
      `Skill "${name}" is pinned and cannot be deleted. ` +
      "Unpin via curator_execute action=unpin before deleting.",
      { error: "pinned" },
    );
  } catch {
    // No .pinned file — safe to delete
  }

  if (dryRun) {
    return simpleResult(
      `Preview: Would delete skill "${name}" (absorbed_into="${absorbedInto}")`,
      { action: "delete", name, absorbedInto, dryRun: true },
    );
  }

  await rm(skillDir, { recursive: true, force: true });

  return simpleResult(
    `Deleted skill "${name}"${absorbedInto ? ` (absorbed into "${absorbedInto}")` : " (pruned)"}`,
    {
      ok: true,
      action: "delete",
      name,
      absorbedInto: absorbedInto || undefined,
    },
  );
}

// ── Helpers ─────────────────────────────────────────────────────

function simpleResult(
  text: string,
  details: Record<string, unknown>,
): ReturnType<typeof createResult> {
  return createResult(text, details);
}

function createResult(
  text: string,
  details: Record<string, unknown>,
): Parameters<AgentTool["execute"]> extends [string, unknown] ? ReturnType<AgentTool["execute"]> : never {
  return {
    content: [{ type: "text", text }],
    details,
  } as unknown as ReturnType<AgentTool["execute"]>;
}

function parseAction(params: unknown): SkillManageAction | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const raw = (params as Record<string, unknown>).action;
  if (ACTIONS.includes(raw as SkillManageAction)) return raw as SkillManageAction;
  return undefined;
}

function parseName(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const raw = (params as Record<string, unknown>).name;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return undefined;
}

function parseDryRun(params: unknown): boolean {
  if (typeof params !== "object" || params === null) return false;
  return (params as Record<string, unknown>).dryRun === true;
}

function parseStringParam(params: unknown, name: string): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const raw = (params as Record<string, unknown>)[name];
  if (typeof raw === "string" && raw.length > 0) return raw;
  return undefined;
}
