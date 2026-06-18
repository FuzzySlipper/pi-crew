/** Effective model-callable tool inventory for pi-crew profiles/sessions. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Profile } from "@pi-crew/profiles";
import type { CrewConfig } from "./config.js";
import {
  CONTROL_COMMAND_CATALOG,
  LOCAL_MODEL_CALLABLE_TOOL_CATALOG,
} from "./local-tool-catalog.js";
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
  readonly mcpServers: readonly McpServerInventoryEntry[];
  readonly mcpCollisions: readonly McpToolCollisionInventoryEntry[];
  readonly requestedSets: readonly string[];
  readonly mcpTools: readonly ToolSelectionEntry[];
  readonly builtInTools: readonly BuiltInToolInventoryEntry[];
  readonly controlCommands: readonly string[];
}

export interface McpServerInventoryEntry {
  readonly name: string;
  readonly endpoint: string;
  readonly optional: boolean;
  readonly toolProfile?: string;
  readonly ok: boolean;
  readonly discoveredToolNames: readonly string[];
  readonly error?: string;
}

export interface McpToolCollisionInventoryEntry {
  readonly toolName: string;
  readonly serverNames: readonly string[];
}

export interface BuiltInToolInventoryEntry {
  readonly name: string;
  readonly category: "delegation" | "helper" | "local" | "planning" | "web" | "browser" | "session" | "memory";
  readonly modelCallable: boolean;
  readonly selected: boolean;
  readonly reason: "selected" | "not_requested" | "profile_denied" | "not_model_callable";
  readonly implementedIn: string;
  readonly assembledIn: readonly string[];
  readonly intendedSurfaces: readonly string[];
  readonly policyGate: string;
  readonly inventoryTest: string;
}

export function buildEffectiveToolInventory(input: {
  readonly agent: CrewConfig["fullAgents"][number];
  readonly profile: Profile;
  readonly mcpEndpoint: string;
  readonly mcpServers?: readonly McpServerInventoryEntry[];
  readonly mcpCollisions?: readonly McpToolCollisionInventoryEntry[];
  readonly mcpTools: readonly AgentTool[];
  readonly selectedToolNames: ReadonlySet<string>;
}): EffectiveToolInventory {
  const requestedSets = requestedToolSets(
    input.agent.runtime.tools.additionalAllow,
    input.profile.toolPolicy,
  );
  return {
    agentId: input.agent.agentId,
    profileId: input.profile.id,
    sessionId: input.agent.session.sessionId,
    mcpEndpoint: input.mcpEndpoint,
    mcpToolProfile: input.profile.mcpConfig?.toolProfile,
    mcpServers: input.mcpServers ?? [],
    mcpCollisions: input.mcpCollisions ?? [],
    requestedSets,
    mcpTools: buildToolSelectionInventory({
      tools: input.mcpTools,
      requestedSets,
      profileToolPolicy: input.profile.toolPolicy,
      selectedNames: input.selectedToolNames,
    }),
    builtInTools: buildBuiltInInventory(requestedSets, input.profile, input.selectedToolNames),
    controlCommands: CONTROL_COMMAND_CATALOG.map((command) => command.name),
  };
}

function buildBuiltInInventory(
  requestedSets: readonly string[],
  profile: Profile,
  selectedNames: ReadonlySet<string>,
): readonly BuiltInToolInventoryEntry[] {
  return BUILT_IN_TOOLS.map((tool) => {
    const requested = requestedSets.some(
      (set) => set === "all" || set === tool.name || (Array.isArray(tool.toolsets) && tool.toolsets.includes(set)),
    );
    const permitted = toolAllowedByProfilePolicy(tool.name, profile.toolPolicy);
    const selected = selectedNames.has(tool.name) || (requested && permitted);
    return {
      ...tool,
      selected,
      reason: selected
        ? "selected"
        : !requested
          ? "not_requested"
          : !permitted
            ? "profile_denied"
            : "not_model_callable",
    };
  });
}

const BUILT_IN_TOOLS = LOCAL_MODEL_CALLABLE_TOOL_CATALOG;
