import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  DEN_MEMORY_TOOL_NAMES,
  DenMemoryClient,
  PiCrewDenMemoryAdapter,
  type DenMemoryPolicyMode,
  type DenMemoryToolName,
  type PiCrewMemoryContextInput,
} from "@pi-crew/memory";

export interface DenMemoryToolConfig {
  readonly baseUrl: string;
  readonly requestTimeoutMs?: number;
  readonly policyMode?: DenMemoryPolicyMode;
  readonly context: PiCrewMemoryContextInput;
}

export function createDenMemoryTools(config: DenMemoryToolConfig): AgentTool[] {
  const client = new DenMemoryClient({
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const adapter = new PiCrewDenMemoryAdapter({
    client,
    runtimeContext: PiCrewDenMemoryAdapter.fromContext(client, config.context).runtimeContext,
    policyMode: config.policyMode,
  });
  return adapter.toolDefinitions().map((definition) => ({
    label: definition.name,
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    execute: async (_toolCallId, params) => {
      const result = await adapter.callTool(definition.name, paramsToRecord(params));
      const text = result.ok ? JSON.stringify(result.data, null, 2) : result.error ?? "Den Memories tool call failed";
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  }));
}

export function denMemoryToolNames(): readonly DenMemoryToolName[] {
  return DEN_MEMORY_TOOL_NAMES;
}

function paramsToRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}
