/**
 * Single shared registry for tool-set membership and matching.
 *
 * Consolidates three previously independent implementations of
 * `toolMatchesSelectedSet` and `TOOL_SET_MEMBERS` so all call
 * sites agree on which tools belong to which sets.
 *
 * @module pi-crew/tool-set-registry
 */

// ── Set membership table ────────────────────────────────────────

/**
 * Defines which exact tool names belong to each named set.
 *
 * A tool matches a set if:
 * 1. Its exact name is listed here, OR
 * 2. Its name matches the fallback rule (exact match or `setName_` prefix).
 *
 * The fallback rule handles MCP tools (`den_*`, `mcp_den_*`) and any
 * tool names that don't warrant an explicit entry in this table.
 */
const TOOL_SET_MEMBERS: Readonly<Record<string, ReadonlySet<string>>> = {
  filesystem: new Set(["read_file", "write_file", "search_files"]),
  filesystem_readonly: new Set(["read_file", "search_files"]),
  local: new Set(["read_file", "write_file", "search_files", "terminal", "git_status", "git_diff"]),
  terminal: new Set(["terminal"]),
  git: new Set(["git_status", "git_diff"]),
  git_diff_log: new Set(["git_status", "git_diff"]),
  planning: new Set(["todo"]),
  session: new Set(["session_search"]),
  web: new Set(["web_search", "web_extract"]),
  browser: new Set([
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_vision",
    "browser_console",
    "browser_scroll",
    "browser_back",
    "browser_press",
  ]),
  memory: new Set([
    "den_memory_recall",
    "den_memory_read",
    "den_memory_search",
    "den_memory_store",
    "den_memory_propose",
    "dense_profile_memory",
  ]),
  delegation: new Set([
    "spawn_subagent",
    "fan_out_subagents",
    "scout_codebase",
    "summarize_files",
    "find_relevant_paths",
  ]),
  // skills set was missing from TOOL_SET_MEMBERS — tools were in the catalog
  // with category "skills" but the set had no members, causing silent filtering.
  skills: new Set(["skills_list", "skill_view", "skill_manage"]),
  // helper tools — available via concrete name or the "helper" set
  helper: new Set(["counter_reset", "curator_execute", "scout_codebase", "summarize_files", "find_relevant_paths"]),
  // den_channels_read_recent is accessed via the channel-readback path
  // and matched by the default rule (exact name match).
};

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
