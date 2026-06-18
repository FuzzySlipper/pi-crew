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

/**
 * Determine the effective tool sets requested for a full agent.
 *
 * Precedence (profile canonical):
 * 1. If the profile's `toolPolicy.mode` is `"allow_list"`, the requested sets
 *    start with the profile's `allow` entries.
 * 2. The agent's `runtime.tools.additionalAllow` is merged in as an *additive*
 *    layer — it can grant additional tool sets but cannot revoke profile-level
 *    grants.
 * 3. If neither source specifies anything, returns `["all"]` (allow everything).
 */
export function requestedToolSets(
  runtimeAdditionalAllow: readonly string[],
  profilePolicy: ToolPolicy | undefined,
): readonly string[] {
  const fromProfile = profilePolicy?.mode === "allow_list" ? (profilePolicy.allow ?? []) : [];
  const fromRuntime = runtimeAdditionalAllow.length > 0 ? runtimeAdditionalAllow : [];

  // If neither source provides explicit sets, default to "all"
  if (fromProfile.length === 0 && fromRuntime.length === 0) return ["all"];

  // Merge: profile sets first, then runtime adds any unique entries
  const merged = new Set([...fromProfile, ...fromRuntime]);
  return [...merged];
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
