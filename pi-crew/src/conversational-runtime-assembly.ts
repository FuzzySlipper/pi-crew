/** Assemble Agent-backed ordinary conversational runtimes from installed config. */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import { ConfigurationError, type Logger, type EventBus } from "@pi-crew/core";
import { type MCPClient, type ToolCallContentBlock, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import { assembleProfilePrompt, loadProfile, type Profile } from "@pi-crew/profiles";
import {
  ConversationalAgentResponder,
  ConversationalAgentResponderFactory,
  type AgentResponderFactory,
  type ConversationalAgentRuntimeBuilder,
} from "@pi-crew/service";

import type { CrewConfig } from "./config.js";

export interface ConversationalRuntimeModelConfig {
  readonly provider: string;
  readonly modelName: string;
  readonly modelBaseUrl?: string;
  readonly apiKey?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface ResolvedConversationalAgentRuntime {
  readonly profile: Profile;
  readonly model: ConversationalRuntimeModelConfig;
  readonly agentModel: Model<Api>;
  readonly systemPrompt: string;
  readonly tools: readonly AgentTool[];
}

export interface ResolveConversationalAgentRuntimeInput {
  readonly agent: CrewConfig["conversationalAgents"][number];
  readonly profilesRoot?: string;
  readonly toolRegistry: McpToolRegistry;
  readonly mcpClient: MCPClient;
  readonly logger: Logger;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface BuildConversationalAgentResponderFactoryInput
  extends ResolveConversationalAgentRuntimeInput {
  readonly eventBus?: EventBus;
}

class StaticConversationalRuntimeBuilder implements ConversationalAgentRuntimeBuilder {
  constructor(
    private readonly input: ResolveConversationalAgentRuntimeInput,
    private readonly logger: Logger,
    private readonly eventBus: EventBus,
  ) {}

  build(): ConversationalAgentResponder {
    const runtime = resolveConversationalAgentRuntime(this.input);
    return new ConversationalAgentResponder({
      eventBus: this.eventBus,
      logger: this.logger,
      model: runtime.agentModel,
      systemPrompt: runtime.systemPrompt,
      tools: runtime.tools,
    });
  }
}

export function buildConversationalAgentResponderFactory(
  input: BuildConversationalAgentResponderFactoryInput,
): AgentResponderFactory {
  if (input.eventBus === undefined) {
    throw new ConfigurationError("Conversational Agent responder factory requires an EventBus");
  }
  resolveConversationalAgentRuntime(input);
  return new ConversationalAgentResponderFactory(
    new StaticConversationalRuntimeBuilder(input, input.logger, input.eventBus),
  );
}

export function resolveConversationalAgentRuntime(
  input: ResolveConversationalAgentRuntimeInput,
): ResolvedConversationalAgentRuntime {
  if (!input.agent.enabled) {
    throw new ConfigurationError(
      `Conversational agent "${input.agent.agentId}" is disabled and cannot be assembled`,
    );
  }
  const profile = loadProfile(input.agent.profileId, input.profilesRoot);
  const model = resolveModelConfig(input.agent, profile, input.env ?? process.env);
  const tools = selectConversationalTools({
    allow: input.agent.runtime.tools.allow,
    mcpClient: input.mcpClient,
    registry: input.toolRegistry,
  });
  return {
    profile,
    model,
    agentModel: createAgentModel(model),
    systemPrompt: assembleProfilePrompt(profile),
    tools,
  };
}

function resolveModelConfig(
  agent: CrewConfig["conversationalAgents"][number],
  profile: Profile,
  env: Readonly<Record<string, string | undefined>>,
): ConversationalRuntimeModelConfig {
  const provider = agent.runtime.provider ?? profile.modelConfig?.provider;
  const modelName = agent.runtime.model ?? profile.modelConfig?.model;
  if (provider === undefined || modelName === undefined) {
    throw new ConfigurationError(
      `Conversational agent "${agent.agentId}" requires a resolved runtime provider and model`,
    );
  }
  return {
    provider,
    modelName,
    modelBaseUrl: agent.runtime.baseUrl ?? profile.modelConfig?.baseUrl,
    apiKey: resolveApiKey(agent.runtime.apiKeyEnv ?? profile.modelConfig?.apiKeyEnv, env),
    temperature: profile.modelConfig?.temperature,
    maxTokens: profile.modelConfig?.maxTokens,
  };
}

function createAgentModel(config: ConversationalRuntimeModelConfig): Model<Api> {
  return {
    id: config.modelName,
    name: config.modelName,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.modelBaseUrl ?? "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: config.maxTokens ?? 4096,
  };
}

function resolveApiKey(
  apiKeyEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (apiKeyEnv === undefined || apiKeyEnv.trim() === "") return undefined;
  return env[apiKeyEnv];
}

function selectConversationalTools(input: {
  readonly allow: readonly string[];
  readonly registry: McpToolRegistry;
  readonly mcpClient: MCPClient;
}): AgentTool[] {
  return input.registry
    .listTools()
    .filter((tool) => input.allow.some((set) => toolMatchesSelectedSet(tool.name, set)))
    .map((tool) => createAgentTool(tool, input.mcpClient));
}

function createAgentTool(
  tool: ReturnType<McpToolRegistry["listTools"]>[number],
  mcpClient: MCPClient,
): AgentTool {
  const parameters = Type.Object({}, { additionalProperties: true });
  return {
    label: tool.name,
    name: tool.name,
    description: tool.description,
    parameters,
    execute: async (_toolCallId, params) => {
      const result = await mcpClient.callTool(tool.name, paramsToRecord(params));
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error ?? "MCP tool call failed" }],
          details: { ok: false, error: result.error },
        };
      }
      return {
        content: result.content.map(contentBlockToText),
        details: { ok: true },
      };
    },
  };
}

function paramsToRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

function toolMatchesSelectedSet(toolName: string, toolSet: string): boolean {
  const normalized = toolName.toLowerCase();
  const normalizedSet = toolSet.toLowerCase();
  if (normalizedSet === "all") return false;
  if (normalizedSet === "den") return SAFE_DEN_TOOL_NAMES.has(stripMcpPrefix(normalized));
  return normalized === normalizedSet || normalized.startsWith(`${normalizedSet}_`);
}

const SAFE_DEN_TOOL_NAMES = new Set([
  "get_task",
  "get_thread",
  "get_messages",
  "get_latest_task_packet",
  "get_latest_worker_completion",
  "get_task_workflow_summary",
  "get_document",
  "search_documents",
  "query_librarian",
  "list_review_findings",
  "list_review_rounds",
  "get_worker_run_status",
]);

function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith("mcp_den_")) return toolName.slice("mcp_den_".length);
  if (toolName.startsWith("den_")) return toolName.slice("den_".length);
  return toolName;
}

function contentBlockToText(block: ToolCallContentBlock): TextContent {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "resource") {
    return { type: "text", text: block.resource.text ?? block.resource.uri };
  }
  return { type: "text", text: `[image:${block.mimeType}]` };
}
