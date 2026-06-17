/**
 * Dense profile memory tool — agent-callable pocket notebook.
 *
 * The tool description constant (`DENSE_PROFILE_MEMORY_TOOL_DESCRIPTION`)
 * is a clearly-marked, editable constant at the top of this file.
 * Profiles can override the tool description text via config
 * (`tools.dense_profile_memory.description` in profile YAML).
 *
 * @module pi-tools/dense-profile-memory-tool
 */

import type { Result } from "@pi-crew/core";
import type {
  DenseMemoryTarget,
  DenseMemoryAction,
  DenseProfileMemoryStore,
} from "@pi-crew/memory";

// ── Tool description (editable constant) ────────────────────────
//
// This is the instruction text the agent sees in its tool schema.
// Edit it here to change the default behaviour for all profiles.
// Override per-profile via `tools.dense_profile_memory.description`.

export const DENSE_PROFILE_MEMORY_TOOL_DESCRIPTION = `
Save or retrieve compact personal notes in the current agent profile's memory store.
Think of this as your personal pocket notebook — facts about the user, the
environment, and your own conventions that should persist across sessions.

Two targets:
- 'memory' — environment facts, project conventions, tool quirks, lessons learned.
- 'user' — user preferences, persona, communication style, pet peeves.

WHEN TO SAVE (do this proactively):
- User corrects you or says "remember this" / "don't do that again"
- User shares a preference, habit, or personal detail
- You discover something about the environment
- You learn a convention, API quirk, or workflow specific to this setup
- You identify a stable fact that will be useful again across sessions

PRIORITY: User preferences and corrections > environment facts > procedural knowledge.

Do NOT save: task progress, session outcomes, completed-work logs, temporary TODO state.
If it will be stale in 7 days, it does not belong in memory.
If you've discovered a non-trivial workflow that should be a reusable procedure,
use skill_manage to create or patch a SKILL.md instead.

Actions:
- 'read' — retrieve current memory content (usually unnecessary — injected in system prompt)
- 'add' — append a new entry (automatically handles caps; oldest entries discarded first)
- 'replace' — replace an existing entry identified by oldText (exact-match substring match)
- 'remove' — delete an existing entry identified by oldText

Be economical with this tool. Each entry should be a single compact line. If nothing
worth saving happened this turn, don't call the tool at all.
`.trim();

// ── Tool parameter schema ───────────────────────────────────────

export interface DenseProfileMemoryToolParams {
  /** Profile ID. Defaults to the current session's profile. */
  profileId?: string;
  /** Target store. */
  target: DenseMemoryTarget;
  /** Action to perform. */
  action: DenseMemoryAction;
  /** Content for add/replace actions. Newline-separated entries. */
  content?: string;
  /** For replace/remove: exact-match substring to identify the entry. */
  oldText?: string;
}

// ── Tool factory ────────────────────────────────────────────────

export interface DenseProfileMemoryToolOptions {
  /** Persistent store. */
  store: DenseProfileMemoryStore;
  /** Resolve profile ID — called when params.profileId is not provided. */
  resolveProfileId: () => string;
  /** Optional custom description override (from profile config). */
  descriptionOverride?: string;
}

export function createDenseProfileMemoryTool(
  options: DenseProfileMemoryToolOptions,
) {
  const description = options.descriptionOverride ?? DENSE_PROFILE_MEMORY_TOOL_DESCRIPTION;

  return {
    name: "dense_profile_memory",
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        profileId: { type: "string", description: "Profile ID. Defaults to current session profile." },
        target: { type: "string", description: "Target: 'memory' or 'user'", enum: ["memory", "user"] },
        action: { type: "string", description: "Action: read, add, replace, or remove", enum: ["read", "add", "replace", "remove"] },
        content: { type: "string", description: "Content for add/replace actions. Newline-separated entries." },
        oldText: { type: "string", description: "For replace/remove: substring identifying the entry to modify." },
      },
      required: ["target", "action"],
    },
    handler: async (params: Record<string, unknown>): Promise<Result<unknown>> => {
      const target = String(params.target) as DenseMemoryTarget;
      const action = String(params.action) as DenseMemoryAction;
      const profileId = params.profileId !== undefined
        ? String(params.profileId)
        : options.resolveProfileId();
      const content = params.content !== undefined ? String(params.content) : undefined;
      const oldText = params.oldText !== undefined ? String(params.oldText) : undefined;

      try {
        const result = await options.store.write({
          profileId,
          target,
          action,
          content,
          oldText,
        });

        if (!result.success) {
          return {
            ok: false,
            error: result.driftError ?? "Write failed",
          };
        }

        return {
          ok: true,
          data: {
            target,
            usedBytes: result.usedBytes,
            capBytes: result.capBytes,
            entryCount: result.entryCount,
            writeToken: result.newToken,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
