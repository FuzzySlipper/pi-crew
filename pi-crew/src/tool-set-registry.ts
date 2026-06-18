/**
 * Single shared registry for tool-set membership and matching.
 *
 * Consolidates three previously independent implementations of
 * `toolMatchesSelectedSet` and `TOOL_SET_MEMBERS` so all call
 * sites agree on which tools belong to which sets.
 *
 * The source of truth for set membership is the catalog
 * (`local-tool-catalog.ts`). This registry derives its membership
 * table from the catalog's `toolsets` field and adds the additional
 * sets (`filesystem`, `filesystem_readonly`, `local`, `terminal`,
 * `git`, `git_diff_log`, `skills`, `helper`) that the catalog's
 * `category` enum doesn't cover.
 *
 * @module pi-crew/tool-set-registry
 */

import { buildToolSetRegistry } from "./local-tool-catalog.js";

// ── Set membership table ────────────────────────────────────────

/**
 * Build the combined set-membership table.
 *
 * Starts with the catalog-derived membership (each tool declares
 * which sets it belongs to via `toolsets`) and adds the coarse-grained
 * aggregator sets (`local`, `filesystem`, `filesystem_readonly`,
 * `git_diff_log`) that group multiple catalog sets.
 */
function buildCombinedSetRegistry(): Readonly<Record<string, ReadonlySet<string>>> {
  const catalogSets = buildToolSetRegistry();

  // Add aggregator sets that group catalog-level categories
  const localTools = [
    ...(catalogSets["filesystem"] ?? []),
    ...(catalogSets["terminal"] ?? []),
    ...(catalogSets["git"] ?? []),
  ];
  const fsTools = catalogSets["filesystem"] ?? [];
  const gitTools = catalogSets["git"] ?? [];

  return {
    ...catalogSets,
    local: new Set(localTools),
    filesystem: new Set(fsTools),
    filesystem_readonly: new Set([...fsTools].filter((t) => t === "read_file" || t === "search_files")),
    git: new Set(gitTools),
    git_diff_log: new Set(gitTools),
    // helper and skills are already in catalogSets from their toolsets
    // but ensure they exist
    helper: new Set([...(catalogSets["helper"] ?? [])]),
    skills: new Set([...(catalogSets["skills"] ?? [])]),
  };
}

const TOOL_SET_MEMBERS = buildCombinedSetRegistry();

export const LOCAL_TOOL_SET_NAMES = new Set(Object.keys(TOOL_SET_MEMBERS));

// ── All-local-tool names ────────────────────────────────────────

/**
 * Set of all known local-tool names, derived from TOOL_SET_MEMBERS.
 *
 * Used by the `"den"` set rule: a tool is considered a Den/MCP tool
 * when it is NOT in this set.
 */
export const ALL_LOCAL_TOOL_NAMES = new Set<string>(
  [...Object.values(TOOL_SET_MEMBERS)].flatMap((s) => Array.from(s)),
);

// ── Matching ────────────────────────────────────────────────────

/**
 * Check whether a tool name belongs to a named set.
 *
 * Rules (in order):
 * 1. `"all"` matches everything.
 * 2. `"den"` matches any tool NOT in {@link ALL_LOCAL_TOOL_NAMES}.
 * 3. If the set has explicit members in {@link TOOL_SET_MEMBERS}, check them.
 * 4. Fallback: exact name match or prefix match (`setName_`).
 */
export function toolMatchesSelectedSet(toolName: string, toolSet: string): boolean {
  const normalized = toolName.toLowerCase();
  const normalizedSet = toolSet.toLowerCase();

  if (normalizedSet === "all") return true;
  if (normalizedSet === "den") return !ALL_LOCAL_TOOL_NAMES.has(normalized);
  if (TOOL_SET_MEMBERS[normalizedSet]?.has(normalized) === true) return true;
  return normalized === normalizedSet || normalized.startsWith(`${normalizedSet}_`);
}

// ── Multi-set check ─────────────────────────────────────────────

/**
 * Check whether a tool name matches any of the given sets.
 */
export function toolRequestedBySets(toolName: string, sets: readonly string[]): boolean {
  return sets.some((set) => toolMatchesSelectedSet(toolName, set));
}

// ── Policy expansion ───────────────────────────────────────────

/**
 * Resolve a ToolPolicy's set-name-based allow/deny lists into concrete
 * tool names for use by {@link FullAgentPolicyInput}.
 *
 * For `"allow_list"` mode, expands each set name to the concrete tool
 * names from {@link TOOL_SET_MEMBERS} plus the set name itself (in case
 * it's already a concrete tool name).
 *
 * For `"deny_list"` mode, expands each set name the same way.
 *
 * Returns empty arrays for `"allow_all"` mode (the sandbox allows everything).
 */
export function resolveToolPolicyToToolNames(
  policy: { readonly mode?: string; readonly allow?: readonly string[]; readonly deny?: readonly string[] } | undefined,
): { readonly allowedTools: readonly string[]; readonly deniedTools: readonly string[] } {
  if (policy === undefined) return { allowedTools: [], deniedTools: [] };
  const mode = policy.mode ?? "allow_all";

  if (mode === "allow_all") return { allowedTools: [], deniedTools: [] };

  if (mode === "allow_list") {
    const allowSetNames = policy.allow ?? [];
    const allowedTools = new Set<string>();
    for (const setName of allowSetNames) {
      const members = TOOL_SET_MEMBERS[setName.toLowerCase()];
      if (members !== undefined) {
        for (const tool of members) allowedTools.add(tool);
      }
      allowedTools.add(setName);
    }
    return { allowedTools: [...allowedTools], deniedTools: [] };
  }

  const denySetNames = policy.deny ?? [];
  const deniedTools = new Set<string>();
  for (const setName of denySetNames) {
    const members = TOOL_SET_MEMBERS[setName.toLowerCase()];
    if (members !== undefined) {
      for (const tool of members) deniedTools.add(tool);
    }
    deniedTools.add(setName);
  }
  return { allowedTools: [], deniedTools: [...deniedTools] };
}
