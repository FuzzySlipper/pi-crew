import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExecutionPolicy } from "@pi-crew/core";
import type { SessionSearchRepository } from "@pi-crew/service";
import type { MCPClient } from "@pi-crew/mcp";
import type { ToolPolicy } from "@pi-crew/profiles";
import { SessionToolFilter } from "@pi-crew/tools";
import type { CrewConfig } from "./config.js";
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
  readonly profileId: string;
  readonly defaultSender: string;
  readonly sessionSearchRepository?: SessionSearchRepository;
  readonly defaultProjectId?: string;
  readonly memory?: CrewConfig["memory"];
}

export function selectFullAgentTools(input: SelectFullAgentToolsInput): AgentTool[] {
  const requestedSets = requestedToolSets(input.allow, input.profileToolPolicy);
  const localTools = createRuntimeLocalTools({
    sessionId: input.sessionId,
    profileId: input.profileId,
    sessionSearchRepository: input.sessionSearchRepository,
    denMemory: memoryConfig(input),
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

function memoryConfig(input: SelectFullAgentToolsInput): Parameters<typeof createRuntimeLocalTools>[0]["denMemory"] {
  if (input.memory?.enabled !== true || input.memory.baseUrl === undefined) return undefined;
  return {
    baseUrl: input.memory.baseUrl,
    requestTimeoutMs: input.memory.requestTimeoutMs,
    policyMode: input.memory.fullAgentPolicy,
    context: {
      agentIdentity: input.defaultSender,
      profileId: input.profileId,
      sessionId: input.sessionId,
      sessionKind: "durable_agent",
      projectId: input.defaultProjectId,
      role: "runner",
      mode: "implementation",
    },
  };
}
