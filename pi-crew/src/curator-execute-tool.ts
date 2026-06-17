/**
 * curator_execute tool — skill curator operations.
 *
 * Called by curator subagent to consolidate, archive, prune, pin, or
 * unpin skills in the profile's skill directory.
 *
 * @module pi-crew/curator-execute-tool
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CuratorService } from "@pi-crew/service";

const ACTIONS = ["consolidate", "archive", "prune", "pin", "unpin"] as const;
type CuratorAction = (typeof ACTIONS)[number];

export interface CuratorExecuteToolInput {
  readonly curatorService: CuratorService | undefined;
}

/**
 * Create a curator_execute tool for the given CuratorService.
 *
 * Returns undefined when curatorService is not provided (no-op).
 */
export function createCuratorExecuteTool(
  input: CuratorExecuteToolInput,
): AgentTool | undefined {
  const { curatorService } = input;
  if (curatorService === undefined) return undefined;

  return {
    label: "Curator Execute",
    name: "curator_execute",
    description:
      "Execute curator operations for skill maintenance: consolidate, archive, prune, pin, or unpin skills. " +
      "When confirmed=false (default) returns a preview of what would happen. " +
      "Pass confirmed=true to apply the action.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description:
            "'consolidate' runs full curator auto-transitions and cleanup, " +
            "'archive' archives stale skills, 'prune' removes stale/archived entries, " +
            "'pin' prevents a skill from being archived, 'unpin' removes the pin.",
        },
        skillName: {
          type: "string",
          description:
            "Name of the skill to pin/unpin (required for 'pin' and 'unpin' actions).",
        },
        confirmed: {
          type: "boolean",
          description:
            "When false (default) returns a preview string. When true, applies the action.",
        },
      },
      required: ["action"],
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

      const confirmed = parseConfirmed(params);
      const skillName = parseSkillName(params);

      // pin and unpin require a skill name
      if ((action === "pin" || action === "unpin") && !skillName) {
        return {
          content: [
            {
              type: "text",
              text: `Skill name is required for "${action}" action.`,
            },
          ],
          details: { ok: false, error: "missing_skill_name" },
        };
      }

      try {
        switch (action) {
          case "pin":
            if (!confirmed) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Preview: Would pin skill "${skillName}". Set confirmed=true to apply.`,
                  },
                ],
                details: { ok: true, action, skillName, confirmed: false },
              };
            }
            await curatorService.pin(skillName!);
            return {
              content: [
                { type: "text", text: `Pinned skill "${skillName}".` },
              ],
              details: { ok: true, action, skillName, confirmed: true },
            };

          case "unpin":
            if (!confirmed) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Preview: Would unpin skill "${skillName}". Set confirmed=true to apply.`,
                  },
                ],
                details: { ok: true, action, skillName, confirmed: false },
              };
            }
            await curatorService.unpin(skillName!);
            return {
              content: [
                { type: "text", text: `Unpinned skill "${skillName}".` },
              ],
              details: { ok: true, action, skillName, confirmed: true },
            };

          case "consolidate":
          case "archive":
          case "prune": {
            if (!confirmed) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `Preview: Would run curator "${action}" pass. This applies ` +
                      `auto-transitions (stale/archive/prune) based on configured thresholds. ` +
                      `Set confirmed=true to execute.`,
                  },
                ],
                details: { ok: true, action, confirmed: false },
              };
            }
            const result = await curatorService.runNow(false);
            return {
              content: [
                {
                  type: "text",
                  text: `Curator "${action}" pass complete. ${result.summary}`,
                },
              ],
              details: {
                ok: true,
                action,
                confirmed: true,
                runId: result.runId,
                summary: result.summary,
                errors: result.errors,
                transitions: result.transitions.length,
              },
            };
          }
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Curator "${action}" failed: ${String(err)}`,
            },
          ],
          details: { ok: false, error: String(err) },
        };
      }
    },
  };
}

function parseAction(params: unknown): CuratorAction | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const raw = (params as Record<string, unknown>)["action"];
  if (ACTIONS.includes(raw as CuratorAction)) return raw as CuratorAction;
  return undefined;
}

function parseConfirmed(params: unknown): boolean {
  if (typeof params !== "object" || params === null) return false;
  return (params as Record<string, unknown>)["confirmed"] === true;
}

function parseSkillName(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const raw = (params as Record<string, unknown>)["skillName"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  return undefined;
}
