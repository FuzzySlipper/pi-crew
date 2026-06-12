/** Assemble Agent-backed ordinary conversational runtimes from installed config. */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getModels, getProviders, Type } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model, TextContent } from "@earendil-works/pi-ai";
import {
  ConfigurationError,
  type DelegationConstraints,
  type EffectiveDelegationRuntime,
  type EventBus,
  type ExecutionPolicy,
  type Logger,
} from "@pi-crew/core";
import {
  type MCPClient,
  type ToolCallContentBlock,
  ToolRegistry as McpToolRegistry,
} from "@pi-crew/mcp";
import {
  assembleProfilePrompt,
  loadProfile,
  type Profile,
  type ToolPolicy,
} from "@pi-crew/profiles";
import {
  ConversationalAgentResponder,
  ConversationalAgentResponderFactory,
  createDelegatedSpawnTool,
  type AgentResponderFactory,
  type AgentResponderFactoryContext,
  type ConversationalAgentFactory,
  type ConversationalAgentRuntimeBuilder,
  type ConversationalTurnHistory,
  type DelegatedSpawnLifecyclePort,
} from "@pi-crew/service";
import {
  type ConversationalPolicyInput,
  createConversationalPolicy,
  SessionToolFilter,
} from "@pi-crew/tools";

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
  readonly executionPolicy: ExecutionPolicy;
}

export interface ResolveConversationalAgentRuntimeInput {
  readonly agent: CrewConfig["conversationalAgents"][number];
  readonly profilesRoot?: string;
  readonly toolRegistry: McpToolRegistry;
  readonly mcpClient: MCPClient;
  readonly logger: Logger;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sessionToolFilter?: SessionToolFilter;
}

export interface ConversationalDelegationRuntimeConfig {
  readonly lifecycle: DelegatedSpawnLifecyclePort;
  readonly parentDelegationConstraints?: DelegationConstraints;
  readonly allowedRuntimes?: readonly EffectiveDelegationRuntime[];
}

export interface BuildConversationalAgentResponderFactoryInput extends ResolveConversationalAgentRuntimeInput {
  readonly eventBus?: EventBus;
  readonly history?: ConversationalTurnHistory;
  readonly agentFactory?: ConversationalAgentFactory;
  readonly delegation?: ConversationalDelegationRuntimeConfig;
}

export interface BuildConversationalAgentResponderFactoryForAgentsInput {
  readonly agents: readonly CrewConfig["conversationalAgents"][number][];
  readonly profilesRoot?: string;
  readonly toolRegistry: McpToolRegistry;
  readonly mcpClient: MCPClient;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly history?: ConversationalTurnHistory;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly agentFactory?: ConversationalAgentFactory;
  readonly delegation?: ConversationalDelegationRuntimeConfig;
}

class StaticConversationalRuntimeBuilder implements ConversationalAgentRuntimeBuilder {
  constructor(
    private readonly input: BuildConversationalAgentResponderFactoryInput,
    private readonly logger: Logger,
    private readonly eventBus: EventBus,
  ) {}

  build(context: AgentResponderFactoryContext): ConversationalAgentResponder {
    const filter = new SessionToolFilter(this.eventBus, this.logger);
    const runtime = resolveConversationalAgentRuntime({ ...this.input, sessionToolFilter: filter });
    const tools = addDelegationTool(runtime, this.input.agent, context, this.input.delegation);
    return createResponder(
      { ...runtime, tools },
      this.logger,
      this.eventBus,
      this.input.history,
      this.input.agentFactory,
    );
  }
}

class ProfileMappedConversationalRuntimeBuilder implements ConversationalAgentRuntimeBuilder {
  constructor(private readonly input: BuildConversationalAgentResponderFactoryForAgentsInput) {}

  build(context: AgentResponderFactoryContext): ConversationalAgentResponder {
    const agent = selectAgentForContext(this.input.agents, context.profileId);
    const filter = new SessionToolFilter(this.input.eventBus, this.input.logger);
    const runtime = resolveConversationalAgentRuntime({ ...this.input, agent, sessionToolFilter: filter });
    const tools = addDelegationTool(runtime, agent, context, this.input.delegation);
    return createResponder(
      { ...runtime, tools },
      this.input.logger,
      this.input.eventBus,
      this.input.history,
      this.input.agentFactory,
    );
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

export function buildConversationalAgentResponderFactoryForAgents(
  input: BuildConversationalAgentResponderFactoryForAgentsInput,
): AgentResponderFactory {
  const enabled = input.agents.filter((agent) => agent.enabled);
  if (enabled.length === 0) {
    throw new ConfigurationError(
      "Conversational Agent runtime assembly requires at least one enabled agent",
    );
  }
  for (const agent of enabled) {
    resolveConversationalAgentRuntime({ ...input, agent });
  }
  return new ConversationalAgentResponderFactory(
    new ProfileMappedConversationalRuntimeBuilder({ ...input, agents: enabled }),
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
  const executionPolicy = buildConversationalExecutionPolicy(input.agent, profile);
  const tools = selectConversationalTools({
    allow: input.agent.runtime.tools.allow,
    profileToolPolicy: profile.toolPolicy,
    registry: input.toolRegistry,
    mcpClient: input.mcpClient,
    policy: executionPolicy,
    sessionToolFilter: input.sessionToolFilter,
    sessionId: input.agent.session.sessionId,
  });
  return {
    profile,
    model,
    agentModel: createAgentModel(model),
    systemPrompt: assembleProfilePrompt(profile),
    tools,
    executionPolicy,
  };
}

function createResponder(
  runtime: ResolvedConversationalAgentRuntime,
  logger: Logger,
  eventBus: EventBus,
  history?: ConversationalTurnHistory,
  agentFactory?: ConversationalAgentFactory,
): ConversationalAgentResponder {
  return new ConversationalAgentResponder({
    ...(agentFactory !== undefined ? { agentFactory } : {}),
    eventBus,
    history,
    logger,
    model: runtime.agentModel,
    apiKey: runtime.model.apiKey,
    maxTokens: runtime.model.maxTokens,
    systemPrompt: runtime.systemPrompt,
    temperature: runtime.model.temperature,
    tools: runtime.tools,
  });
}

function addDelegationTool(
  runtime: ResolvedConversationalAgentRuntime,
  agent: CrewConfig["conversationalAgents"][number],
  context: AgentResponderFactoryContext,
  delegation: ConversationalDelegationRuntimeConfig | undefined,
): readonly AgentTool[] {
  if (delegation === undefined || !agentAllowsDelegation(agent, runtime)) return runtime.tools;
  const parentSessionId = context.sessionId ?? agent.session.sessionId;
  const parentRuntime = parentRuntimeFor(agent, runtime);
  return [
    ...runtime.tools,
    createDelegatedSpawnTool({
      lifecycle: delegation.lifecycle,
      parentSessionId,
      parentPolicy: runtime.executionPolicy,
      parentDelegationConstraints: delegation.parentDelegationConstraints ?? { maxSpawnDepth: 1 },
      parentRuntime,
      allowedRuntimes: delegation.allowedRuntimes ?? [parentRuntime],
    }) as unknown as AgentTool,
  ];
}

function agentAllowsDelegation(
  agent: CrewConfig["conversationalAgents"][number],
  runtime: ResolvedConversationalAgentRuntime,
): boolean {
  const requested = agent.runtime.tools.allow.some((entry) =>
    entry === "delegation" || entry === "spawn_subagent"
  );
  if (!requested) return false;
  if (!toolAllowedByProfilePolicy("spawn_subagent", runtime.profile.toolPolicy)) return false;
  if (runtime.executionPolicy.deniedTools.includes("spawn_subagent")) return false;
  return runtime.executionPolicy.allowedTools.length === 0
    || runtime.executionPolicy.allowedTools.includes("spawn_subagent");
}

function parentRuntimeFor(
  agent: CrewConfig["conversationalAgents"][number],
  runtime: ResolvedConversationalAgentRuntime,
): EffectiveDelegationRuntime {
  return {
    profileId: agent.profileId,
    provider: runtime.model.provider,
    model: runtime.model.modelName,
  };
}

function selectAgentForContext(
  agents: readonly CrewConfig["conversationalAgents"][number][],
  profileId: string,
): CrewConfig["conversationalAgents"][number] {
  if (agents.length === 1) {
    const only = agents[0];
    if (only === undefined) {
      throw new ConfigurationError("No enabled conversational agent is available");
    }
    if (only.profileId !== profileId) {
      throw new ConfigurationError(
        `No configured conversational agent matches profile ${profileId}`,
      );
    }
    return only;
  }
  const match = agents.find((agent) => agent.profileId === profileId);
  if (match === undefined) {
    throw new ConfigurationError(`No configured conversational agent matches profile ${profileId}`);
  }
  return match;
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
  if (profile.toolPolicy === undefined) {
    throw new ConfigurationError(
      `Conversational agent "${agent.agentId}" requires profile toolPolicy when runtime.toolPolicy.mode is profile`,
    );
  }
  const apiKey = resolveApiKey(agent.runtime.apiKeyEnv ?? profile.modelConfig?.apiKeyEnv, env);
  return {
    provider,
    modelName,
    modelBaseUrl: agent.runtime.baseUrl ?? profile.modelConfig?.baseUrl,
    apiKey,
    temperature: profile.modelConfig?.temperature,
    maxTokens: profile.modelConfig?.maxTokens,
  };
}

function createAgentModel(config: ConversationalRuntimeModelConfig): Model<Api> {
  if (isKnownProvider(config.provider)) {
    const registered = getModels(config.provider).find((model) => model.id === config.modelName);
    if (registered !== undefined) {
      return {
        ...registered,
        baseUrl: config.modelBaseUrl ?? registered.baseUrl,
        maxTokens: config.maxTokens ?? registered.maxTokens,
      };
    }
    if (config.modelBaseUrl === undefined) {
      throw new ConfigurationError(
        `Conversational model ${config.provider}/${config.modelName} is not registered and has no OpenAI-compatible baseUrl`,
      );
    }
  } else if (config.modelBaseUrl === undefined) {
    throw new ConfigurationError(
      `Conversational provider ${config.provider} is not registered and has no OpenAI-compatible baseUrl`,
    );
  }
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

function isKnownProvider(provider: string): provider is KnownProvider {
  return getProviders().includes(provider as KnownProvider);
}

function resolveApiKey(
  apiKeyEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (apiKeyEnv === undefined || apiKeyEnv.trim() === "") return undefined;
  const value = env[apiKeyEnv];
  if (value === undefined || value.trim() === "") {
    throw new ConfigurationError(
      `Required conversational agent API key env ${apiKeyEnv} is not set`,
    );
  }
  return value;
}

// ── Execution policy derivation ─────────────────────────────────

function buildConversationalExecutionPolicy(
  agent: CrewConfig["conversationalAgents"][number],
  profile: Profile,
): ExecutionPolicy {
  const input: ConversationalPolicyInput = {
    policyId: `conv-${agent.agentId}-${agent.session.sessionId}`,
    deniedTools: [...(profile.toolPolicy?.deny ?? [])],
  };
  return createConversationalPolicy(input);
}

// ── Tool selection with policy enforcement ──────────────────────

function selectConversationalTools(input: {
  readonly allow: readonly string[];
  readonly profileToolPolicy: ToolPolicy | undefined;
  readonly registry: McpToolRegistry;
  readonly mcpClient: MCPClient;
  readonly policy: ExecutionPolicy;
  readonly sessionToolFilter: SessionToolFilter | undefined;
  readonly sessionId: string;
}): AgentTool[] {
  const beforePolicy = input.registry
    .listTools()
    .filter((tool) => input.allow.some((set) => toolMatchesSelectedSet(tool.name, set)))
    .filter((tool) => toolAllowedByProfilePolicy(tool.name, input.profileToolPolicy));

  // Apply ExecutionPolicy-based tool filtering
  const afterPolicy = input.sessionToolFilter !== undefined
    ? input.sessionToolFilter.filter(
        input.policy,
        input.sessionId,
        beforePolicy.map((tool) => tool.name),
        null,
      )
    : beforePolicy.map((tool) => tool.name);

  const allowedSet = new Set(afterPolicy);
  return beforePolicy
    .filter((tool) => allowedSet.has(tool.name))
    .map((tool) => createAgentTool(tool, input.mcpClient));
}

function toolAllowedByProfilePolicy(toolName: string, policy: ToolPolicy | undefined): boolean {
  if (policy === undefined) return false;
  const mode = policy.mode ?? "allow_all";
  if (mode === "allow_all") return true;
  if (mode === "allow_list") {
    return (policy.allow ?? []).some((entry) => toolMatchesSelectedSet(toolName, entry));
  }
  return !(policy.deny ?? []).some((entry) => toolMatchesSelectedSet(toolName, entry));
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
  "get_task_workflow_summary",
  "get_document",
  "search_documents",
  "query_librarian",
  "list_review_findings",
  "list_review_rounds",
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
