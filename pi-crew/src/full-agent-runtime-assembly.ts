import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import {
  ConfigurationError,
  type DelegationConstraints,
  type EffectiveDelegationRuntime,
  type EventBus,
  type ExecutionPolicy,
  type Logger,
} from "@pi-crew/core";
import { assembleProfilePrompt, loadProfile, type Profile } from "@pi-crew/profiles";
import {
  FullAgentResponder,
  FullAgentResponderFactory,
  createDelegatedFanOutTool,
  createDelegatedSpawnTool,
  createDelegationHelperTools,
  type AgentResponderFactory,
  type AgentResponderFactoryContext,
  type FullAgentFactory,
  type FullAgentRuntimeBuilder,
  type FullAgentTurnHistory,
  type SessionSearchRepository,
  type StreamRetryConfig,
  type DelegatedSpawnLifecyclePort,
} from "@pi-crew/service";
import {
  type FullAgentPolicyInput,
  createFullAgentPolicy,
  SessionToolFilter,
} from "@pi-crew/tools";
import type { CrewConfig } from "./config.js";
import { createFullAgentContextPolicyResolver } from "./den-router-metadata-client.js";
import { createDenChannelReadbackTool } from "./den-channel-readback-tool.js";
import { selectFullAgentTools } from "./full-agent-tool-selection.js";
import { todoContextMessage } from "./todo-tool.js";
import type { DenChannelReadbackToolConfig } from "./den-channel-readback-tool.js";
import type { McpSurfaceManager } from "./mcp-surface-manager.js";
import { buildEffectiveToolInventory, type EffectiveToolInventory } from "./tool-inventory.js";
import {
  requestedToolSets,
  toolAllowedByProfilePolicy,
  toolMatchesSelectedSet,
} from "./tool-selection.js";
export interface FullAgentRuntimeModelConfig { readonly provider: string; readonly modelName: string; readonly modelBaseUrl?: string; readonly api?: "openai-completions" | "openai-responses"; readonly apiKey?: string; readonly temperature?: number; readonly maxTokens?: number; }
export interface ResolvedFullAgentRuntime {
  readonly profile: Profile;
  readonly model: FullAgentRuntimeModelConfig;
  readonly agentModel: Model<Api>;
  readonly systemPrompt: string;
  readonly tools: readonly AgentTool[];
  readonly executionPolicy: ExecutionPolicy;
  readonly inventory: EffectiveToolInventory;
}
export interface ResolveFullAgentRuntimeInput {
  readonly agent: CrewConfig["fullAgents"][number];
  readonly profilesRoot?: string;
  readonly mcpSurfaceManager: McpSurfaceManager;
  readonly logger: Logger;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sessionToolFilter?: SessionToolFilter;
  readonly defaultDenProjectId?: string;
  readonly sessionSearchRepository?: SessionSearchRepository;
  readonly memory?: CrewConfig["memory"];
}
export interface FullAgentDelegationRuntimeConfig {
  readonly lifecycle: DelegatedSpawnLifecyclePort;
  readonly parentDelegationConstraints?: DelegationConstraints;
  readonly allowedRuntimes?: readonly EffectiveDelegationRuntime[];
}
export interface DenChannelReadbackRuntimeConfig extends Omit<DenChannelReadbackToolConfig, "allowedChannelIds"> {}
export interface BuildFullAgentResponderFactoryInput extends ResolveFullAgentRuntimeInput {
  readonly eventBus?: EventBus;
  readonly history?: FullAgentTurnHistory;
  readonly sessionSearchRepository?: SessionSearchRepository;
  readonly agentFactory?: FullAgentFactory;
  readonly delegation?: FullAgentDelegationRuntimeConfig;
  readonly channelReadback?: DenChannelReadbackRuntimeConfig;
  readonly defaultDenProjectId?: string;
  readonly crewContext: CrewConfig["context"];
  readonly streamRetry?: StreamRetryConfig;
}
export interface BuildFullAgentResponderFactoryForAgentsInput {
  readonly agents: readonly CrewConfig["fullAgents"][number][];
  readonly profilesRoot?: string;
  readonly mcpSurfaceManager: McpSurfaceManager;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly history?: FullAgentTurnHistory;
  readonly sessionSearchRepository?: SessionSearchRepository;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly agentFactory?: FullAgentFactory;
  readonly delegation?: FullAgentDelegationRuntimeConfig;
  readonly channelReadback?: DenChannelReadbackRuntimeConfig;
  readonly defaultDenProjectId?: string;
  readonly crewContext: CrewConfig["context"];
  readonly streamRetry?: StreamRetryConfig;
}
class StaticFullAgentRuntimeBuilder implements FullAgentRuntimeBuilder {
  constructor(
    private readonly input: BuildFullAgentResponderFactoryInput,
    private readonly logger: Logger,
    private readonly eventBus: EventBus,
  ) {}
  build(context: AgentResponderFactoryContext): FullAgentResponder {
    const filter = new SessionToolFilter(this.eventBus, this.logger);
    const runtime = resolveFullAgentRuntime({ ...this.input, sessionToolFilter: filter });
    const withReadback = addChannelReadbackTool(
      runtime,
      this.input.agent,
      this.input.channelReadback,
    );
    const tools = addDelegationTool(withReadback, this.input.agent, context, this.input.delegation);
    const toolsProvider = () => {
      const freshRuntime = resolveFullAgentRuntime({ ...this.input, sessionToolFilter: filter });
      const freshWithReadback = addChannelReadbackTool(
        freshRuntime,
        this.input.agent,
        this.input.channelReadback,
      );
      return addDelegationTool(freshWithReadback, this.input.agent, context, this.input.delegation);
    };
    return createResponder(
      { ...runtime, tools },
      this.logger,
      this.eventBus,
      this.input.history,
      this.input.agentFactory,
      toolsProvider,
      this.input.crewContext,
      this.input.streamRetry,
    );
  }
}
class ProfileMappedFullAgentRuntimeBuilder implements FullAgentRuntimeBuilder {
  constructor(private readonly input: BuildFullAgentResponderFactoryForAgentsInput) {}
  build(context: AgentResponderFactoryContext): FullAgentResponder {
    const agent = selectAgentForContext(this.input.agents, context.profileId);
    const filter = new SessionToolFilter(this.input.eventBus, this.input.logger);
    const runtime = resolveFullAgentRuntime({
      ...this.input,
      agent,
      sessionToolFilter: filter,
    });
    const withReadback = addChannelReadbackTool(runtime, agent, this.input.channelReadback);
    const tools = addDelegationTool(withReadback, agent, context, this.input.delegation);
    const toolsProvider = () => {
      const freshRuntime = resolveFullAgentRuntime({
        ...this.input,
        agent,
        sessionToolFilter: filter,
      });
      const freshWithReadback = addChannelReadbackTool(
        freshRuntime,
        agent,
        this.input.channelReadback,
      );
      return addDelegationTool(freshWithReadback, agent, context, this.input.delegation);
    };
    return createResponder(
      { ...runtime, tools },
      this.input.logger,
      this.input.eventBus,
      this.input.history,
      this.input.agentFactory,
      toolsProvider,
      this.input.crewContext,
      this.input.streamRetry,
    );
  }
}
export function buildFullAgentResponderFactory(
  input: BuildFullAgentResponderFactoryInput,
): AgentResponderFactory {
  if (input.eventBus === undefined) {
    throw new ConfigurationError("FullAgent Agent responder factory requires an EventBus");
  }
  resolveFullAgentRuntime(input);
  return new FullAgentResponderFactory(
    new StaticFullAgentRuntimeBuilder(input, input.logger, input.eventBus),
  );
}
export function buildFullAgentResponderFactoryForAgents(
  input: BuildFullAgentResponderFactoryForAgentsInput,
): AgentResponderFactory {
  const enabled = input.agents.filter((agent) => agent.enabled);
  if (enabled.length === 0) {
    throw new ConfigurationError(
      "FullAgent Agent runtime assembly requires at least one enabled agent",
    );
  }
  for (const agent of enabled) {
    resolveFullAgentRuntime({ ...input, agent });
  }
  return new FullAgentResponderFactory(
    new ProfileMappedFullAgentRuntimeBuilder({ ...input, agents: enabled }),
  );
}
export function resolveFullAgentRuntime(
  input: ResolveFullAgentRuntimeInput,
): ResolvedFullAgentRuntime {
  if (!input.agent.enabled) {
    throw new ConfigurationError(
      `Full agent "${input.agent.agentId}" is disabled and cannot be assembled`,
    );
  }
  const profile = loadProfile(input.agent.profileId, input.profilesRoot);
  const surface = input.mcpSurfaceManager.surfaceForProfile(profile);
  const model = resolveModelConfig(input.agent, profile, input.env ?? process.env);
  const executionPolicy = buildFullAgentExecutionPolicy(input.agent, profile);
  const tools = selectFullAgentTools({
    allow: input.agent.runtime.tools.allow,
    profileToolPolicy: profile.toolPolicy,
    mcpTools: surface.registry.listTools(),
    mcpClient: surface.client,
    policy: executionPolicy,
    sessionToolFilter: input.sessionToolFilter,
    sessionId: input.agent.session.sessionId,
    profileId: input.agent.profileId,
    defaultSender: input.agent.profileIdentity,
    sessionSearchRepository: input.sessionSearchRepository,
    defaultProjectId: input.defaultDenProjectId,
    memory: input.memory,
  });
  const selectedNames = new Set(tools.map((tool) => tool.name));
  return {
    profile,
    model,
    agentModel: createAgentModel(model),
    systemPrompt: assembleProfilePrompt(profile),
    tools,
    executionPolicy,
    inventory: buildEffectiveToolInventory({
      agent: input.agent,
      profile,
      mcpEndpoint: surface.endpoint,
      mcpServers: surface.servers.map((server) => ({
        name: server.name,
        endpoint: server.endpoint,
        optional: server.optional,
        ...(server.toolProfile === undefined ? {} : { toolProfile: server.toolProfile }),
        ok: server.error === undefined,
        discoveredToolNames: server.discoveredToolNames,
        ...(server.error === undefined ? {} : { error: server.error }),
      })),
      mcpCollisions: surface.collisions,
      mcpTools: surface.registry.listTools(),
      selectedToolNames: selectedNames,
    }),
  };
}
function createResponder(
  runtime: ResolvedFullAgentRuntime,
  logger: Logger,
  eventBus: EventBus,
  history?: FullAgentTurnHistory,
  agentFactory?: FullAgentFactory,
  toolsProvider?: () => readonly AgentTool[],
  crewContext?: CrewConfig["context"],
  streamRetry?: StreamRetryConfig,
): FullAgentResponder {
  return new FullAgentResponder({
    ...(agentFactory !== undefined ? { agentFactory } : {}),
    eventBus,
    history,
    extraContextProvider: (sessionId) => [todoContextMessage(sessionId)].filter(
      (message): message is NonNullable<ReturnType<typeof todoContextMessage>> => message !== null,
    ),
    logger,
    model: runtime.agentModel,
    apiKey: runtime.model.apiKey,
    maxTokens: runtime.model.maxTokens,
    systemPrompt: runtime.systemPrompt,
    temperature: runtime.model.temperature,
    tools: runtime.tools,
    toolsProvider,
    streamRetry,
    contextPolicyProvider: createFullAgentContextPolicyResolver({
      crewContext: crewContext ?? {
        defaultContextLength: 131072,
        compactionThresholdPercent: 80,
        minimumRecentMessages: 24,
      },
      provider: runtime.model.provider,
      modelName: runtime.model.modelName,
      modelBaseUrl: runtime.model.modelBaseUrl,
      logger,
    }),
  });
}
function addChannelReadbackTool(
  runtime: ResolvedFullAgentRuntime,
  agent: CrewConfig["fullAgents"][number],
  channelReadback: DenChannelReadbackRuntimeConfig | undefined,
): ResolvedFullAgentRuntime {
  if (channelReadback === undefined) return runtime;
  const requestedSets = requestedToolSets(agent.runtime.tools.allow, runtime.profile.toolPolicy);
  if (!requestedSets.some((entry) => toolMatchesSelectedSet("den_channels_read_recent", entry)))
    return runtime;
  if (!toolAllowedByProfilePolicy("den_channels_read_recent", runtime.profile.toolPolicy))
    return runtime;
  if (runtime.executionPolicy.deniedTools.includes("den_channels_read_recent")) return runtime;
  const allowedChannelIds = agent.channels.map((channel) => channel.channelId);
  return {
    ...runtime,
    tools: [
      ...runtime.tools,
      createDenChannelReadbackTool({ ...channelReadback, allowedChannelIds }),
    ],
  };
}
function addDelegationTool(
  runtime: ResolvedFullAgentRuntime,
  agent: CrewConfig["fullAgents"][number],
  context: AgentResponderFactoryContext,
  delegation: FullAgentDelegationRuntimeConfig | undefined,
): readonly AgentTool[] {
  if (delegation === undefined || !agentAllowsDelegation(agent, runtime)) return runtime.tools;
  const parentSessionId = context.sessionId ?? agent.session.sessionId;
  const parentRuntime = parentRuntimeFor(agent, runtime);
  const parentPolicy = parentPolicyForDelegation(runtime);
  const constraints = delegation.parentDelegationConstraints ?? { maxSpawnDepth: 1 };
  const commonOptions = {
    lifecycle: delegation.lifecycle,
    parentSessionId,
    parentPolicy,
    parentDelegationConstraints: constraints,
    parentRuntime,
    allowedRuntimes: delegation.allowedRuntimes ?? [],
  };
  return [
    ...runtime.tools,
    createDelegatedSpawnTool(commonOptions) as unknown as AgentTool,
    createDelegatedFanOutTool(commonOptions) as unknown as AgentTool,
    ...createAllowedDelegationHelperTools(runtime, commonOptions),
  ];
}
function createAllowedDelegationHelperTools(
  runtime: ResolvedFullAgentRuntime,
  options: Parameters<typeof createDelegationHelperTools>[0],
): readonly AgentTool[] {
  return createDelegationHelperTools(options)
    .filter((tool) => toolAllowedByProfilePolicy(tool.name, runtime.profile.toolPolicy))
    .filter((tool) => !runtime.executionPolicy.deniedTools.includes(tool.name))
    .filter(
      (tool) =>
        runtime.executionPolicy.allowedTools.length === 0 ||
        runtime.executionPolicy.allowedTools.includes(tool.name),
    ) as unknown as readonly AgentTool[];
}
function parentPolicyForDelegation(runtime: ResolvedFullAgentRuntime): ExecutionPolicy {
  if (runtime.executionPolicy.allowedTools.length > 0) return runtime.executionPolicy;
  return {
    ...runtime.executionPolicy,
    allowedTools: runtime.tools.map((tool) => tool.name),
  };
}
function agentAllowsDelegation(
  agent: CrewConfig["fullAgents"][number],
  runtime: ResolvedFullAgentRuntime,
): boolean {
  const requestedSets = requestedToolSets(agent.runtime.tools.allow, runtime.profile.toolPolicy);
  const requested = requestedSets.some(
    (entry) =>
      entry === "all" ||
      entry === "delegation" ||
      entry === "spawn_subagent" ||
      entry === "fan_out_subagents",
  );
  if (!requested) return false;
  if (!toolAllowedByProfilePolicy("spawn_subagent", runtime.profile.toolPolicy)) return false;
  if (!toolAllowedByProfilePolicy("fan_out_subagents", runtime.profile.toolPolicy)) return false;
  if (runtime.executionPolicy.deniedTools.includes("spawn_subagent")) return false;
  if (runtime.executionPolicy.deniedTools.includes("fan_out_subagents")) return false;
  return (
    runtime.executionPolicy.allowedTools.length === 0 ||
    (runtime.executionPolicy.allowedTools.includes("spawn_subagent") &&
      runtime.executionPolicy.allowedTools.includes("fan_out_subagents"))
  );
}
function parentRuntimeFor(
  agent: CrewConfig["fullAgents"][number],
  runtime: ResolvedFullAgentRuntime,
): EffectiveDelegationRuntime {
  return {
    profileId: agent.profileId,
    provider: runtime.model.provider,
    model: runtime.model.modelName,
  };
}
function selectAgentForContext(
  agents: readonly CrewConfig["fullAgents"][number][],
  profileId: string,
): CrewConfig["fullAgents"][number] {
  if (agents.length === 1) {
    const only = agents[0];
    if (only === undefined) {
      throw new ConfigurationError("No enabled full agent is available");
    }
    if (only.profileId !== profileId) {
      throw new ConfigurationError(`No configured full agent matches profile ${profileId}`);
    }
    return only;
  }
  const match = agents.find((agent) => agent.profileId === profileId);
  if (match === undefined) {
    throw new ConfigurationError(`No configured full agent matches profile ${profileId}`);
  }
  return match;
}
function resolveModelConfig(
  agent: CrewConfig["fullAgents"][number],
  profile: Profile,
  env: Readonly<Record<string, string | undefined>>,
): FullAgentRuntimeModelConfig {
  const provider = agent.runtime.provider ?? profile.modelConfig?.provider;
  const modelName = agent.runtime.model ?? profile.modelConfig?.model;
  if (provider === undefined || modelName === undefined) {
    throw new ConfigurationError(
      `Full agent "${agent.agentId}" requires a resolved runtime provider and model`,
    );
  }
  if (profile.toolPolicy === undefined) {
    throw new ConfigurationError(
      `Full agent "${agent.agentId}" requires profile toolPolicy when runtime.toolPolicy.mode is profile`,
    );
  }
  const apiKey = resolveApiKey(agent.runtime.apiKeyEnv ?? profile.modelConfig?.apiKeyEnv, env);
  return {
    provider,
    modelName,
    modelBaseUrl: agent.runtime.baseUrl ?? profile.modelConfig?.baseUrl,
    api: agent.runtime.api ?? profile.modelConfig?.api,
    apiKey,
    temperature: profile.modelConfig?.temperature,
    maxTokens: profile.modelConfig?.maxTokens,
  };
}
function createAgentModel(config: FullAgentRuntimeModelConfig): Model<Api> {
  if (isKnownProvider(config.provider)) {
    const registered = getModels(config.provider).find((model) => model.id === config.modelName);
    if (registered !== undefined) {
      return {
        ...registered,
        api: config.api ?? registered.api,
        baseUrl: config.modelBaseUrl ?? registered.baseUrl,
        maxTokens: config.maxTokens ?? registered.maxTokens,
      };
    }
    if (config.modelBaseUrl === undefined) {
      throw new ConfigurationError(
        `FullAgent model ${config.provider}/${config.modelName} is not registered and has no OpenAI-compatible baseUrl`,
      );
    }
  } else if (config.modelBaseUrl === undefined) {
    throw new ConfigurationError(
      `FullAgent provider ${config.provider} is not registered and has no OpenAI-compatible baseUrl`,
    );
  }
  return {
    id: config.modelName,
    name: config.modelName,
    api: config.api ?? "openai-completions",
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
    throw new ConfigurationError(`Required full agent API key env ${apiKeyEnv} is not set`);
  }
  return value;
}
function buildFullAgentExecutionPolicy(
  agent: CrewConfig["fullAgents"][number],
  profile: Profile,
): ExecutionPolicy {
  const input: FullAgentPolicyInput = {
    policyId: `conv-${agent.agentId}-${agent.session.sessionId}`,
    deniedTools: [...(profile.toolPolicy?.deny ?? [])],
  };
  return createFullAgentPolicy(input);
}
