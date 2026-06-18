/** Shared tool selection helpers for fullAgent and inventory surfaces. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolPolicy } from "@pi-crew/profiles";
import { toolMatchesSelectedSet } from "./tool-set-registry.js";

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

function toolRequestedBySets(toolName: string, sets: readonly string[]): boolean {
  return sets.some((set) => toolMatchesSelectedSet(toolName, set));
}
