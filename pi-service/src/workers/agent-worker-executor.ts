/** Production LLM-backed WorkerExecutor using pi-agent-core Agent. */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentEvent } from "@earendil-works/pi-agent-core";
import {
  getModels,
  getProviders,
  streamSimple,
  type Api,
  type KnownProvider,
  type Model,
} from "@earendil-works/pi-ai";
import type { DelegationConstraints, EffectiveDelegationRuntime } from "@pi-crew/core";
import { ConfigurationError } from "@pi-crew/core";
import type { AgentLike, SteerableAgent } from "./agent-supervisor.js";
import type { AgentTool } from "./guarded-tool-types.js";
import type {
  WorkerExecutionContext,
  WorkerExecutionResult,
  WorkerExecutor,
} from "./worker-runtime.js";
import type { WorkerRoleConfig } from "./worker-role-config.js";
import type { WorkerProfileToolPolicy } from "./worker-role-assembly.js";
import type { WorkerRoleInput } from "./worker-role-assembly.js";
import type { DelegatedSpawnLifecycle } from "./delegated-spawn-lifecycle.js";
import { createDelegatedSpawnTool } from "./delegated-spawn-tool.js";
import { buildWorkerPolicy } from "./worker-policy-builder.js";

export interface WorkerModelConfig {
  readonly provider?: string;
  readonly modelName?: string;
  readonly modelBaseUrl?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly apiKey?: string;
  readonly usesCustomBaseUrl?: boolean;
}

export interface WorkerModelConfigSource {
  getProfileModelConfig(profileId: string): WorkerModelConfig | undefined;
  getProfileToolPolicy?(profileId: string): WorkerProfileToolPolicy | undefined;
}

export interface AgentWorkerAdapter extends AgentLike, SteerableAgent {
  state: { tools: AgentTool[] };
  beforeToolCall?: unknown;
  afterToolCall?: unknown;
  prompt(messages: AgentMessage[]): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): void;
}

export interface AgentWorkerFactoryInput {
  readonly model: Model<Api>;
  readonly systemPrompt: string;
  readonly sessionId: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly apiKey?: string;
  readonly usesCustomBaseUrl?: boolean;
}

export interface AgentWorkerFactory {
  create(input: AgentWorkerFactoryInput): AgentWorkerAdapter;
}

export interface AgentWorkerToolProviderInput {
  readonly roleInput: WorkerRoleInput;
  readonly toolSets: readonly string[];
}

export type AgentWorkerToolProvider = (input: AgentWorkerToolProviderInput) => AgentTool[];

export interface AgentWorkerExecutorConfig {
  readonly agentFactory?: AgentWorkerFactory;
  readonly modelConfigSource?: WorkerModelConfigSource;
  readonly toolProvider?: AgentWorkerToolProvider;
  readonly delegatedSpawnLifecycle?: DelegatedSpawnLifecycle;
  readonly delegatedSpawnConstraints?: DelegationConstraints;
  readonly delegatedSpawnAllowedRuntimes?: readonly EffectiveDelegationRuntime[];
}

interface ResolvedWorkerModelConfig {
  readonly provider: string;
  readonly modelName: string;
  readonly modelBaseUrl?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly apiKey?: string;
  readonly usesCustomBaseUrl?: boolean;
}

export class DefaultAgentWorkerFactory implements AgentWorkerFactory {
  create(input: AgentWorkerFactoryInput): AgentWorkerAdapter {
    const agent = new Agent({
      getApiKey: () => input.apiKey ?? (input.usesCustomBaseUrl === true ? "unused" : undefined),
      streamFn: (model, context, options) =>
        streamSimple(model, context, {
          ...options,
          temperature: input.temperature ?? options?.temperature,
          maxTokens: input.maxTokens ?? options?.maxTokens,
        }),
      sessionId: input.sessionId,
      initialState: {
        model: input.model,
        systemPrompt: input.systemPrompt,
      },
    });
    return agent;
  }
}

export class AgentWorkerExecutor implements WorkerExecutor {
  readonly #agentFactory: AgentWorkerFactory;
  readonly #modelConfigSource: WorkerModelConfigSource | undefined;
  readonly #toolProvider: AgentWorkerToolProvider;
  readonly #delegatedSpawnLifecycle: DelegatedSpawnLifecycle | undefined;
  readonly #delegatedSpawnConstraints: DelegationConstraints;
  readonly #delegatedSpawnAllowedRuntimes: readonly EffectiveDelegationRuntime[] | undefined;

  constructor(config: AgentWorkerExecutorConfig = {}) {
    this.#agentFactory = config.agentFactory ?? new DefaultAgentWorkerFactory();
    this.#modelConfigSource = config.modelConfigSource;
    this.#toolProvider = config.toolProvider ?? (() => []);
    this.#delegatedSpawnLifecycle = config.delegatedSpawnLifecycle;
    this.#delegatedSpawnConstraints = config.delegatedSpawnConstraints ?? { maxSpawnDepth: 1 };
    this.#delegatedSpawnAllowedRuntimes = config.delegatedSpawnAllowedRuntimes;
  }

  async execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    const roleConfig = context.roleConfig;
    if (roleConfig?.executionMode === "legacyExecutor") {
      throw new ConfigurationError(
        "AgentWorkerExecutor requires llmAgent worker execution; refusing deterministic/legacy fallback",
      );
    }

    const assembly = context.getWorkerRoleAssembly();
    if (assembly === undefined) {
      throw new ConfigurationError(
        `No WorkerRoleAssembly is available for role "${context.binding.role}"`,
      );
    }

    const baseRoleInput = context.buildWorkerRoleInput();
    const profileToolPolicy = this.#modelConfigSource?.getProfileToolPolicy?.(
      baseRoleInput.profileId,
    );
    const roleInput: WorkerRoleInput =
      profileToolPolicy === undefined ? baseRoleInput : { ...baseRoleInput, profileToolPolicy };
    const modelConfig = resolveWorkerModelConfig(
      roleConfig,
      this.#modelConfigSource?.getProfileModelConfig(roleInput.profileId),
      context.binding.role,
    );
    const model = resolvePiModel(modelConfig);
    const toolSets = assembly.selectMcpToolSets(roleInput);
    const delegatedSpawnTool = this.#createDelegatedSpawnTool(
      context,
      roleInput,
      toolSets,
      modelConfig,
    );
    const rawTools = [
      ...this.#toolProvider({ roleInput, toolSets }),
      ...(delegatedSpawnTool === undefined ? [] : [delegatedSpawnTool]),
    ];
    if (rawTools.length === 0) {
      throw new ConfigurationError(
        `LLM Agent worker role "${context.binding.role}" has no tools from selected tool sets [${toolSets.join(", ")}]`,
      );
    }
    const completionState = { posted: false };
    const tools = markCompletionTool(rawTools, () => {
      completionState.posted = true;
    });
    if (!tools.some((tool) => tool.name === "post_structured_completion")) {
      throw new ConfigurationError(
        `LLM Agent worker role "${context.binding.role}" requires post_structured_completion in its tool surface`,
      );
    }
    if (!tools.some((tool) => !isStaticControlTool(tool))) {
      throw new ConfigurationError(
        `LLM Agent worker role "${context.binding.role}" requires at least one selected work tool in addition to static control tools`,
      );
    }

    if (context.signal?.aborted === true) {
      return {
        status: "failed",
        artifacts: [
          {
            type: "llm_agent_aborted_before_start",
            ref: `run:${context.binding.runId}`,
            summary: "Agent-backed worker assignment was aborted before prompt start",
          },
        ],
        filesTouched: [],
        toolsUsed: tools.map((tool) => tool.name),
        tokensConsumed: 0,
        turnCount: 0,
        summary: "Agent-backed worker was aborted before the first LLM turn",
        blocker: {
          reason: "assignment signal was already aborted",
          requires: "human",
          details: buildSummary(context, modelConfig, 0),
        },
      };
    }

    const agent = this.#agentFactory.create({
      model,
      systemPrompt: assembly.buildSystemPrompt(roleInput),
      sessionId: context.session.id,
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
      apiKey: modelConfig.apiKey,
      usesCustomBaseUrl: modelConfig.usesCustomBaseUrl,
    });
    agent.state.tools = tools;

    const abortOnSignal = (): void => {
      agent.abort();
    };
    context.signal?.addEventListener("abort", abortOnSignal, { once: true });

    const supervisor = context.createAgentSupervisor(agent);
    supervisor.start();
    try {
      await agent.prompt(assembly.buildInitialMessages(roleInput));
      await agent.waitForIdle();
    } finally {
      context.signal?.removeEventListener("abort", abortOnSignal);
      supervisor.stop();
    }

    if (!completionState.posted) {
      return {
        status: "failed",
        artifacts: [
          {
            type: "llm_agent_missing_completion",
            ref: `run:${context.binding.runId}`,
            summary: "Agent stopped without calling post_structured_completion",
          },
        ],
        filesTouched: [],
        toolsUsed: tools.map((tool) => tool.name),
        tokensConsumed: supervisor.tokensUsed,
        turnCount: supervisor.turnCount,
        summary: "Agent-backed worker stopped before posting structured completion",
        blocker: {
          reason: "post_structured_completion was not called",
          requires: "human",
          details: buildSummary(context, modelConfig, supervisor.turnCount),
        },
      };
    }

    return {
      status: "completed",
      artifacts: [
        {
          type: "llm_agent_worker_run",
          ref: `run:${context.binding.runId}`,
          summary:
            `Agent-backed ${context.binding.role} assignment completed ` +
            `with ${modelConfig.provider}/${modelConfig.modelName}`,
        },
      ],
      filesTouched: [],
      toolsUsed: tools.map((tool) => tool.name),
      tokensConsumed: supervisor.tokensUsed,
      turnCount: supervisor.turnCount,
      summary: buildSummary(context, modelConfig, supervisor.turnCount),
    };
  }

  #createDelegatedSpawnTool(
    context: WorkerExecutionContext,
    roleInput: WorkerRoleInput,
    toolSets: readonly string[],
    modelConfig: ResolvedWorkerModelConfig,
  ): AgentTool | undefined {
    if (this.#delegatedSpawnLifecycle === undefined) return undefined;
    if (!toolSets.some((toolSet) => toolSet.toLowerCase() === "delegation")) return undefined;
    const parentRuntime = {
      profileId: roleInput.profileId,
      provider: modelConfig.provider,
      model: modelConfig.modelName,
    } satisfies EffectiveDelegationRuntime;
    return createDelegatedSpawnTool({
      lifecycle: this.#delegatedSpawnLifecycle,
      parentSessionId: context.session.id,
      parentPolicy: buildWorkerPolicy(context.binding, context.roleConfig),
      parentDelegationConstraints:
        context.session.delegationConstraints ?? this.#delegatedSpawnConstraints,
      parentLineage: context.session.delegation,
      parentRuntime,
      allowedRuntimes: this.#delegatedSpawnAllowedRuntimes ?? [parentRuntime],
      correlation: {
        assignmentId: context.binding.assignmentId,
        runId: context.binding.runId,
        taskId: context.binding.taskId,
        profileId: roleInput.profileId,
      },
    });
  }
}

function isStaticControlTool(tool: AgentTool): boolean {
  return tool.name === "post_structured_completion" || tool.name === "context_status";
}

function markCompletionTool(tools: readonly AgentTool[], markPosted: () => void): AgentTool[] {
  return tools.map((tool) => {
    if (tool.name !== "post_structured_completion") return tool;
    const originalTool = tool;
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const result = await originalTool.execute(toolCallId, params, signal, onUpdate);
        markPosted();
        return result;
      },
    };
  });
}

function resolveWorkerModelConfig(
  roleConfig: WorkerRoleConfig | undefined,
  profileConfig: WorkerModelConfig | undefined,
  role: string,
): ResolvedWorkerModelConfig {
  const provider = roleConfig?.modelProvider ?? profileConfig?.provider;
  const modelName = roleConfig?.modelName ?? profileConfig?.modelName;
  if (provider === undefined || modelName === undefined) {
    throw new ConfigurationError(
      `LLM Agent worker role "${role}" requires modelProvider and modelName from role config or profile modelConfig`,
    );
  }
  return {
    provider,
    modelName,
    modelBaseUrl: roleConfig?.modelBaseUrl ?? profileConfig?.modelBaseUrl,
    temperature: roleConfig?.temperature ?? profileConfig?.temperature,
    maxTokens: roleConfig?.maxTokens ?? profileConfig?.maxTokens,
    apiKey: profileConfig?.apiKey,
    usesCustomBaseUrl: (roleConfig?.modelBaseUrl ?? profileConfig?.modelBaseUrl) !== undefined,
  };
}

function resolvePiModel(config: ResolvedWorkerModelConfig): Model<Api> {
  if (config.modelBaseUrl !== undefined) {
    return createOpenAiCompatibleModel(config);
  }

  const provider = asKnownProvider(config.provider);
  if (provider === null) {
    throw new ConfigurationError(
      `Unknown LLM provider "${config.provider}" and no modelBaseUrl was configured`,
    );
  }
  const model = getModels(provider).find((candidate) => candidate.id === config.modelName);
  if (model === undefined) {
    throw new ConfigurationError(
      `Model "${config.modelName}" is not registered for provider "${config.provider}"`,
    );
  }
  return model;
}

function asKnownProvider(provider: string): KnownProvider | null {
  return getProviders().includes(provider as KnownProvider) ? (provider as KnownProvider) : null;
}

function createOpenAiCompatibleModel(
  config: ResolvedWorkerModelConfig,
): Model<"openai-completions"> {
  const maxTokens = config.maxTokens ?? 2048;
  return {
    id: config.modelName,
    name: config.modelName,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.modelBaseUrl ?? "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      thinkingFormat: "qwen",
    },
  };
}

function buildSummary(
  context: WorkerExecutionContext,
  modelConfig: ResolvedWorkerModelConfig,
  turnCount: number,
): string {
  return [
    `Agent-backed worker assignment ${context.binding.assignmentId} completed.`,
    `runId=${context.binding.runId}`,
    `taskId=${context.binding.taskId}`,
    `sessionId=${context.session.id}`,
    `profileId=${context.session.profileId}`,
    `modelProvider=${modelConfig.provider}`,
    `modelName=${modelConfig.modelName}`,
    `turnCount=${String(turnCount)}`,
  ].join(" ");
}

export type { AgentEvent };
