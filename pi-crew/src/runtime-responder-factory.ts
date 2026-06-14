/**
 * Runtime responder factory selection for the pi-crew composition root.
 *
 * @module pi-crew/runtime-responder-factory
 */

import type { EventBus, Logger } from "@pi-crew/core";
import { ConfigurationError } from "@pi-crew/core";
import {
  DeterministicArithmeticTool,
  DeterministicToolAgentResponderFactory,
  EchoAgentResponderFactory,
  type AgentResponderFactory,
  type ConversationalTurnHistory,
  type RuntimeConfig,
} from "@pi-crew/service";
import type { McpSurfaceManager } from "./mcp-surface-manager.js";

import type { CrewConfig } from "./config.js";
import { resolveCrewInstallLayout } from "./config.js";
import { buildConversationalAgentResponderFactoryForAgents } from "./conversational-runtime-assembly.js";
import type {
  ConversationalDelegationRuntimeConfig,
  DenChannelReadbackRuntimeConfig,
} from "./conversational-runtime-assembly.js";

/**
 * Build the AgentResponderFactory selected by validated runtime config.
 */
export function buildRuntimeResponderFactory(
  runtime: RuntimeConfig | CrewConfig,
  eventBus: EventBus,
  logger?: Logger,
  mcpSurfaceManager?: McpSurfaceManager,
  history?: ConversationalTurnHistory,
  delegation?: ConversationalDelegationRuntimeConfig,
  channelReadback?: DenChannelReadbackRuntimeConfig,
): AgentResponderFactory {
  if (isCrewConfig(runtime)) {
    const agents = runtime.conversationalAgents.filter((candidate) => candidate.enabled);
    if (agents.length > 0) {
      if (logger === undefined || mcpSurfaceManager === undefined) {
        throw new ConfigurationError(
          "Conversational Agent runtime assembly requires logger and MCP surface manager",
        );
      }
      const profilesRoot = resolveCrewInstallLayout(runtime).profilesRoot;
      return buildConversationalAgentResponderFactoryForAgents({
        agents,
        profilesRoot,
        mcpSurfaceManager,
        logger,
        eventBus,
        history,
        delegation,
        channelReadback,
        defaultDenProjectId: runtime.den.channelsProjectId,
      });
    }
    return buildRuntimeResponderFactory(runtime.runtime, eventBus);
  }
  switch (runtime.responseMode) {
    case "echo":
      return new EchoAgentResponderFactory();
    case "deterministicTool":
      if (!runtime.deterministicTool.arithmeticToolEnabled) {
        throw new ConfigurationError(
          "Deterministic runtime mode requires runtime.deterministicTool.arithmeticToolEnabled=true",
        );
      }
      return new DeterministicToolAgentResponderFactory({
        tool: new DeterministicArithmeticTool(),
        eventBus,
      });
  }

  const exhaustive: never = runtime.responseMode;
  throw new ConfigurationError(`Unsupported runtime response mode: ${String(exhaustive)}`);
}

function isCrewConfig(value: RuntimeConfig | CrewConfig): value is CrewConfig {
  return "conversationalAgents" in value;
}
