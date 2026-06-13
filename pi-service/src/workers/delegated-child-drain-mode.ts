/** Drain-mode helpers for delegated child execution. */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { DelegationSpawnRequest } from "@pi-crew/core";

export function buildDrainModePrompt(spawnRequest: DelegationSpawnRequest): string {
  const contract =
    spawnRequest.expectedResultSchema === "implementation"
      ? "Call post_delegated_implementation_result once, or return exactly one <delegated_implementation_result>...</delegated_implementation_result> JSON object, using the evidence you already gathered."
      : spawnRequest.expectedResultSchema === "review"
        ? "Call post_delegated_review_result once, or return exactly one <delegated_review_result>...</delegated_review_result> JSON object, using the evidence you already gathered."
        : "Return your final answer using the evidence you already gathered.";
  return [
    "You are at the delegated child iteration budget.",
    "Do not call more tools; the tool surface has been removed for drain mode.",
    contract,
    "If evidence is incomplete, return a structured blocked or insufficient_evidence result with the handles/checks you do have rather than continuing to investigate.",
  ].join("\n");
}

export function turnHadToolResults(event: AgentEvent): boolean {
  const toolResults = (event as { readonly toolResults?: readonly unknown[] }).toolResults;
  return Array.isArray(toolResults) && toolResults.length > 0;
}
