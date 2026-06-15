import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBrowserTools } from "./browser-tools.js";
import { createLocalCodeTools } from "./local-code-tools.js";
import { localModelCallableToolNames } from "./local-tool-catalog.js";
import { createTodoTool } from "./todo-tool.js";
import { createWebTools } from "./web-tools.js";

export interface RuntimeLocalToolConfig {
  readonly sessionId: string;
  readonly profileId: string;
  readonly rootPath?: string;
}

export const runtimeLocalToolNames = localModelCallableToolNames();

export function createRuntimeLocalTools(config: RuntimeLocalToolConfig): AgentTool[] {
  return [
    ...createLocalCodeTools({ rootPath: config.rootPath }),
    createTodoTool({ sessionId: config.sessionId }),
    ...createWebTools(),
    ...createBrowserTools({ sessionId: config.sessionId, profileId: config.profileId }),
  ];
}
