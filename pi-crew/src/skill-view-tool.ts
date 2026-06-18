/**
 * skill_view tool — read a skill's full content.
 *
 * Equivalent to Hermes skill_view but operating on the pi-crew profile's
 * skills directory. Returns SKILL.md content (frontmatter + body) plus
 * linked files (references/, templates/, scripts/, assets/).
 * Truncated at a configurable limit with a notice.
 *
 * @module pi-crew/skill-view-tool
 */

import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// ── Constants ───────────────────────────────────────────────────

const SKILL_FILE = "SKILL.md";
const LINKED_DIRS = ["references", "templates", "scripts", "assets"] as const;
const DEFAULT_MAX_CHARS = 6000;

// ── Config ──────────────────────────────────────────────────────

export interface SkillViewToolInput {
  readonly skillsRoot: string;
  readonly maxChars?: number;
}

// ── Factory ─────────────────────────────────────────────────────

export function createSkillViewTool(input: SkillViewToolInput): AgentTool {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;

  return {
    label: "Skill View",
    name: "skill_view",
    description:
      "Read the full content of a pi-crew skill by name. Returns the SKILL.md " +
      "(frontmatter + body) plus any linked files in references/, templates/, " +
      "scripts/, or assets/ subdirectories. Content is truncated at ~6000 chars " +
      "with a truncation notice. Also searches .archive/ for archived skills " +
      "when not found in the active directory.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          description:
            "Skill name (the directory name, matching the skill's frontmatter name field).",
        },
      },
      required: ["name"],
    },
    execute: async (_toolCallId, params) => {
      const skillName = parseName(params);
      if (skillName === undefined) {
        return {
          content: [{ type: "text", text: 'Missing required parameter: "name".' }],
          details: { ok: false, error: "missing_name" },
        };
      }

      // Try active directory first
      const activePath = join(input.skillsRoot, skillName);
      let skillDir = activePath;
      let isArchived = false;

      try {
        await stat(join(activePath, SKILL_FILE));
      } catch {
        // Not in active — try archived
        const archivedPath = join(input.skillsRoot, ".archive", skillName);
        try {
          await stat(join(archivedPath, SKILL_FILE));
          skillDir = archivedPath;
          isArchived = true;
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `Skill "${skillName}" not found in active or archived skills.`,
              },
            ],
            details: { ok: false, error: "not_found" },
          };
        }
      }

      // Read SKILL.md
      let skillMdContent: string;
      try {
        skillMdContent = await readFile(join(skillDir, SKILL_FILE), "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading SKILL.md for "${skillName}": ${String(err)}`,
            },
          ],
          details: { ok: false, error: "read_error" },
        };
      }

      let truncated = false;
      let bodyContent = skillMdContent;
      if (bodyContent.length > maxChars) {
        bodyContent = bodyContent.slice(0, maxChars) +
          `\n\n[... content truncated at ${maxChars} chars; full size: ${skillMdContent.length} chars]`;
        truncated = true;
      }

      // Read linked files
      const linkedFiles: Record<string, string> = {};
      let linkedFileCount = 0;
      let linkedTruncated = false;

      for (const subdir of LINKED_DIRS) {
        const subdirPath = join(skillDir, subdir);
        try {
          const dirStat = await stat(subdirPath);
          if (!dirStat.isDirectory()) continue;
        } catch {
          continue;
        }

        try {
          const entries = await readdir(subdirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isFile()) continue;
            const filePath = join(subdirPath, entry.name);
            const relPath = `${subdir}/${entry.name}`;
            try {
              const content = await readFile(filePath, "utf-8");
              const remaining = maxChars - bodyContent.length -
                Object.values(linkedFiles).reduce((a, b) => a + b.length, 0);
              if (content.length > remaining) {
                linkedFiles[relPath] = content.slice(0, Math.max(remaining, 200)) +
                  `\n[... truncated]`;
                linkedTruncated = true;
              } else {
                linkedFiles[relPath] = content;
              }
              linkedFileCount++;
            } catch {
              // Skip unreadable files
            }
          }
        } catch {
          // Can't read subdirectory — skip
        }
      }

      const result: Record<string, unknown> = {
        name: skillName,
        archived: isArchived,
        content: bodyContent,
        linkedFiles: Object.keys(linkedFiles).length > 0 ? linkedFiles : undefined,
        linkedFileCount,
        truncated,
        linkedTruncated,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: { ok: true, ...result },
      };
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function parseName(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const raw = (params as Record<string, unknown>).name;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return undefined;
}
