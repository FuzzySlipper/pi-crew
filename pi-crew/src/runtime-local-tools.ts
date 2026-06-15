import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SessionSearchRepository } from "@pi-crew/service";
import { createBrowserTools } from "./browser-tools.js";
import { createDenMemoryTools, type DenMemoryToolConfig } from "./den-memory-tools.js";
import { createLocalCodeTools } from "./local-code-tools.js";
import { localModelCallableToolNames } from "./local-tool-catalog.js";
import { createTodoTool } from "./todo-tool.js";
import { createSessionSearchTool } from "./session-search-tool.js";
import { createWebTools } from "./web-tools.js";

export interface RuntimeLocalToolConfig {
  readonly sessionId: string;
  readonly profileId: string;
  readonly rootPath?: string;
  readonly sessionSearchRepository?: SessionSearchRepository;
  readonly denMemory?: DenMemoryToolConfig;
}

export const runtimeLocalToolNames = localModelCallableToolNames();

export function createRuntimeLocalTools(config: RuntimeLocalToolConfig): AgentTool[] {
  return [
    ...createLocalCodeTools({ rootPath: config.rootPath }),
    createTodoTool({ sessionId: config.sessionId }),
    ...sessionSearchTools(config),
    ...denMemoryTools(config),
    ...createWebTools(),
    ...createBrowserTools({ sessionId: config.sessionId, profileId: config.profileId }),
  ];
}

function denMemoryTools(config: RuntimeLocalToolConfig): AgentTool[] {
  if (config.denMemory === undefined) return [];
  return createDenMemoryTools(config.denMemory);
}

function sessionSearchTools(config: RuntimeLocalToolConfig): AgentTool[] {
  if (config.sessionSearchRepository === undefined) return [];
  return [createSessionSearchTool({
    profileId: config.profileId,
    repository: config.sessionSearchRepository,
  })];
}
