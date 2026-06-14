/** Shared tool selection helpers for conversational and inventory surfaces. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolPolicy } from "@pi-crew/profiles";

export interface ToolSelectionEntry {
  readonly name: string;
  readonly requested: boolean;
  readonly permittedByProfile: boolean;
  readonly selected: boolean;
  readonly reason: "selected" | "not_requested" | "profile_denied";
}

export function requestedToolSets(
  runtimeAllow: readonly string[],
  profilePolicy: ToolPolicy | undefined,
): readonly string[] {
  if (runtimeAllow.length > 0) return runtimeAllow;
  if (profilePolicy?.mode === "allow_list") return profilePolicy.allow ?? [];
  return ["all"];
}

export function selectToolsBeforeSessionPolicy(input: {
  readonly tools: readonly AgentTool[];
  readonly requestedSets: readonly string[];
  readonly profileToolPolicy: ToolPolicy | undefined;
}): AgentTool[] {
  return input.tools
    .filter((tool) => toolRequestedBySets(tool.name, input.requestedSets))
    .filter((tool) => toolAllowedByProfilePolicy(tool.name, input.profileToolPolicy));
}

export function buildToolSelectionInventory(input: {
  readonly tools: readonly AgentTool[];
  readonly requestedSets: readonly string[];
  readonly profileToolPolicy: ToolPolicy | undefined;
  readonly selectedNames: ReadonlySet<string>;
}): readonly ToolSelectionEntry[] {
  return input.tools.map((tool) => {
    const requested = toolRequestedBySets(tool.name, input.requestedSets);
    const permittedByProfile = toolAllowedByProfilePolicy(tool.name, input.profileToolPolicy);
    const selected = input.selectedNames.has(tool.name);
    return {
      name: tool.name,
      requested,
      permittedByProfile,
      selected,
      reason: selected ? "selected" : requested && !permittedByProfile ? "profile_denied" : "not_requested",
    };
  });
}

export function toolAllowedByProfilePolicy(
  toolName: string,
  policy: ToolPolicy | undefined,
): boolean {
  if (policy === undefined) return false;
  const mode = policy.mode ?? "allow_all";
  if (mode === "allow_all") return true;
  if (mode === "allow_list") {
    return (policy.allow ?? []).some((entry) => toolMatchesSelectedSet(toolName, entry));
  }
  return !(policy.deny ?? []).some((entry) => toolMatchesSelectedSet(toolName, entry));
}

export function toolRequestedBySets(toolName: string, sets: readonly string[]): boolean {
  return sets.some((set) => toolMatchesSelectedSet(toolName, set));
}

export function toolMatchesSelectedSet(toolName: string, toolSet: string): boolean {
  const normalized = toolName.toLowerCase();
  const normalizedSet = toolSet.toLowerCase();
  if (normalizedSet === "all") return true;
  if (normalizedSet === "den") return SAFE_DEN_TOOL_NAMES.has(stripMcpPrefix(normalized));
  return normalized === normalizedSet || normalized.startsWith(`${normalizedSet}_`);
}

export const SAFE_DEN_TOOL_NAMES = new Set([
  "get_task",
  "get_thread",
  "get_messages",
  "get_latest_task_packet",
  "get_task_workflow_summary",
  "get_document",
  "search_documents",
  "query_librarian",
  "list_review_findings",
  "list_review_rounds",
  "den_channels_read_recent",
  "channels_read_recent",
]);

function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith("mcp_den_")) return toolName.slice("mcp_den_".length);
  if (toolName.startsWith("den_")) return toolName.slice("den_".length);
  return toolName;
}
