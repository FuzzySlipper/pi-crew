/** Effective model-callable tool inventory for pi-crew profiles/sessions. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Profile } from "@pi-crew/profiles";
import type { CrewConfig } from "./config.js";
import {
  buildToolSelectionInventory,
  requestedToolSets,
  toolAllowedByProfilePolicy,
  type ToolSelectionEntry,
} from "./tool-selection.js";

export interface EffectiveToolInventory {
  readonly agentId: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly mcpEndpoint: string;
  readonly mcpToolProfile?: string;
  readonly requestedSets: readonly string[];
  readonly mcpTools: readonly ToolSelectionEntry[];
  readonly builtInTools: readonly BuiltInToolInventoryEntry[];
  readonly controlCommands: readonly string[];
}

export interface BuiltInToolInventoryEntry {
  readonly name: string;
  readonly category: "delegation" | "helper" | "local";
  readonly modelCallable: boolean;
  readonly selected: boolean;
  readonly reason: "selected" | "not_requested" | "profile_denied" | "not_model_callable";
}

export function buildEffectiveToolInventory(input: {
  readonly agent: CrewConfig["conversationalAgents"][number];
  readonly profile: Profile;
  readonly mcpEndpoint: string;
  readonly mcpTools: readonly AgentTool[];
  readonly selectedToolNames: ReadonlySet<string>;
}): EffectiveToolInventory {
  const requestedSets = requestedToolSets(input.agent.runtime.tools.allow, input.profile.toolPolicy);
  return {
    agentId: input.agent.agentId,
    profileId: input.profile.id,
    sessionId: input.agent.session.sessionId,
    mcpEndpoint: input.mcpEndpoint,
    mcpToolProfile: input.profile.mcpConfig?.toolProfile,
    requestedSets,
    mcpTools: buildToolSelectionInventory({
      tools: input.mcpTools,
      requestedSets,
      profileToolPolicy: input.profile.toolPolicy,
      selectedNames: input.selectedToolNames,
    }),
    builtInTools: buildBuiltInInventory(requestedSets, input.profile, input.selectedToolNames),
    controlCommands: ["/help", "/status", "/session", "/new", "/reload-mcp", "/tools"],
  };
}

function buildBuiltInInventory(
  requestedSets: readonly string[],
  profile: Profile,
  selectedNames: ReadonlySet<string>,
): readonly BuiltInToolInventoryEntry[] {
  return BUILT_IN_TOOLS.map((tool) => {
    const requested = requestedSets.some((set) => set === "all" || set === tool.name || set === tool.category);
    const permitted = toolAllowedByProfilePolicy(tool.name, profile.toolPolicy);
    const selected = selectedNames.has(tool.name) || (tool.modelCallable && requested && permitted);
    return {
      ...tool,
      selected,
      reason: selected ? "selected" : !requested ? "not_requested" : !permitted ? "profile_denied" : "not_model_callable",
    };
  });
}

const BUILT_IN_TOOLS: readonly Omit<BuiltInToolInventoryEntry, "selected" | "reason">[] = [
  { name: "spawn_subagent", category: "delegation", modelCallable: true },
  { name: "fan_out_subagents", category: "delegation", modelCallable: true },
  { name: "scout_codebase", category: "helper", modelCallable: true },
  { name: "summarize_files", category: "helper", modelCallable: true },
  { name: "find_relevant_paths", category: "helper", modelCallable: true },
  { name: "read_file", category: "local", modelCallable: true },
  { name: "write_file", category: "local", modelCallable: true },
  { name: "search_files", category: "local", modelCallable: true },
  { name: "terminal", category: "local", modelCallable: true },
  { name: "git_status", category: "local", modelCallable: true },
  { name: "git_diff", category: "local", modelCallable: true },
];
