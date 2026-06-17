/**
 * counter_reset tool — background review counter reset.
 *
 * Called by review/caretaker agents to reset turn or skill-iteration
 * counters after completing a review pass.
 *
 * @module pi-crew/counter-reset-tool
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CounterService, TriggerType } from "@pi-crew/service";

const TRIGGER_TYPES = ["memory", "skill", "combined"] as const;

export interface CreateCounterResetToolInput {
  readonly counterService: CounterService | undefined;
  readonly sessionId: string;
  readonly profileId: string;
}

/**
 * Create a counter_reset tool for the given profile+session pair.
 *
 * Returns undefined when counterService is not provided (no-op).
 */
export function createCounterResetTool(
  input: CreateCounterResetToolInput,
): AgentTool | undefined {
  const { counterService, profileId, sessionId } = input;
  if (counterService === undefined) return undefined;

  return {
    label: "Reset Review Counters",
    name: "counter_reset",
    description:
      "Reset accumulated turn or tool-iteration counters for the current session. " +
      "Call after completing a memory or skill review pass to prevent duplicate nudges.",
    parameters: {
      type: "object",
      properties: {
        triggerType: {
          type: "string",
          enum: [...TRIGGER_TYPES],
          description:
            "'memory' resets the turn counter, 'skill' resets the iteration counter, 'combined' resets both.",
        },
      },
      required: ["triggerType"],
    },
    execute: async (_toolCallId, params) => {
      const triggerType = parseTriggerType(params);

      if (triggerType === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid triggerType. Must be one of: ${TRIGGER_TYPES.join(", ")}`,
            },
          ],
          details: { ok: false, error: "invalid_trigger_type" },
        };
      }

      await counterService.resetCounter(profileId, sessionId, triggerType);

      return {
        content: [
          {
            type: "text",
            text: `Review counter reset for trigger type "${triggerType}".`,
          },
        ],
        details: { ok: true, triggerType },
      };
    },
  };
}

function parseTriggerType(params: unknown): TriggerType | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const raw = (params as Record<string, unknown>)["triggerType"];
  if (TRIGGER_TYPES.includes(raw as TriggerType)) return raw as TriggerType;
  return undefined;
}
