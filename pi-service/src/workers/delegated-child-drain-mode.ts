/** Drain-mode helpers for delegated child execution. */

import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { DelegationSpawnRequest } from "@pi-crew/core";

export function buildDrainModePrompt(spawnRequest: DelegationSpawnRequest): string {
  const contract =
    spawnRequest.expectedResultSchema === "implementation"
      ? "Call post_delegated_implementation_result exactly once with the final structured result using evidence you already gathered."
      : spawnRequest.expectedResultSchema === "review"
        ? "Call post_delegated_review_result exactly once with the final structured review result using evidence you already gathered."
        : "Return your final answer using the evidence you already gathered.";
  return [
    "You are at the delegated child iteration budget.",
    "Do not call investigative/workflow tools. In drain mode only the structured-result finalizer tool remains available when a schema requires it.",
    contract,
    "If evidence is incomplete, return a structured blocked or insufficient_evidence result with the handles/checks you do have rather than continuing to investigate.",
  ].join("\n");
}

export function selectDrainModeTools(
  tools: readonly AgentTool[],
  expectedResultSchema: DelegationSpawnRequest["expectedResultSchema"],
): AgentTool[] {
  const finalizerName =
    expectedResultSchema === "implementation"
      ? "post_delegated_implementation_result"
      : expectedResultSchema === "review"
        ? "post_delegated_review_result"
        : undefined;
  return finalizerName === undefined ? [] : tools.filter((tool) => tool.name === finalizerName);
}

export function turnHadToolResults(event: AgentEvent): boolean {
  const toolResults = (event as { readonly toolResults?: readonly unknown[] }).toolResults;
  return Array.isArray(toolResults) && toolResults.length > 0;
}
