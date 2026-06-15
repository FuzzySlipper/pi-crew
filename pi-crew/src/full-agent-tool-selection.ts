import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExecutionPolicy } from "@pi-crew/core";
import type { MCPClient } from "@pi-crew/mcp";
import type { ToolPolicy } from "@pi-crew/profiles";
import { SessionToolFilter } from "@pi-crew/tools";
import { createFullAgentMcpAgentTool } from "./full-agent-mcp-tool.js";
import { createRuntimeLocalTools, runtimeLocalToolNames } from "./runtime-local-tools.js";
import { requestedToolSets, selectToolsBeforeSessionPolicy } from "./tool-selection.js";

export interface SelectFullAgentToolsInput {
  readonly allow: readonly string[];
  readonly profileToolPolicy: ToolPolicy | undefined;
  readonly mcpTools: readonly AgentTool[];
  readonly mcpClient: MCPClient;
  readonly policy: ExecutionPolicy;
  readonly sessionToolFilter: SessionToolFilter | undefined;
  readonly sessionId: string;
  readonly defaultSender: string;
  readonly defaultProjectId?: string;
}

export function selectFullAgentTools(input: SelectFullAgentToolsInput): AgentTool[] {
  const requestedSets = requestedToolSets(input.allow, input.profileToolPolicy);
  const localTools = createRuntimeLocalTools({
    sessionId: input.sessionId,
    profileId: input.defaultSender,
  });
  const localToolNameSet = new Set<string>(runtimeLocalToolNames);
  const beforePolicy = selectToolsBeforeSessionPolicy({
    tools: [...input.mcpTools, ...localTools],
    requestedSets,
    profileToolPolicy: input.profileToolPolicy,
  });
  const afterPolicy = input.sessionToolFilter?.filter(
    input.policy,
    input.sessionId,
    beforePolicy.map((tool) => tool.name),
    null,
  ) ?? beforePolicy.map((tool) => tool.name);
  const allowedSet = new Set(afterPolicy);
  return beforePolicy
    .filter((tool) => allowedSet.has(tool.name))
    .map((tool) => {
      if (localToolNameSet.has(tool.name)) return tool;
      return createFullAgentMcpAgentTool(
        tool as unknown as Parameters<typeof createFullAgentMcpAgentTool>[0],
        input.mcpClient,
        {
          sender: input.defaultSender,
          projectId: input.defaultProjectId,
        },
      );
    });
}
