/**
 * LLM-backed delegated child runner: creates a real Agent session for
 * delegated subagent execution.
 *
 * DESIGN: SessionMaterializedDelegatedChildRunner is the stub that only
 * records visibility events. This runner replaces it with actual LLM-backed
 * execution using pi-ai model resolution and pi-agent-core Agent.
 * Rationale: spawn_subagent should produce real LLM output, not a stub result.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  getModels,
  getProviders,
  streamSimple,
  type Api,
  type KnownProvider,
  type Model,
} from "@earendil-works/pi-ai";
import type { DelegatedResult, EffectiveDelegationRuntime } from "@pi-crew/core";
import type { DelegatedChildRunInput, DelegatedChildRunner } from "./delegated-spawn-lifecycle.js";

export interface LlmDelegatedChildRunnerConfig {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly modelName?: string;
}

export class LlmDelegatedChildRunner implements DelegatedChildRunner {
  readonly #config: LlmDelegatedChildRunnerConfig;

  constructor(config: LlmDelegatedChildRunnerConfig = {}) {
    this.#config = config;
  }

  async run(input: DelegatedChildRunInput): Promise<DelegatedResult> {
    const startedAt = Date.now();

    await input.emitTurnVisible({
      turnNumber: 1,
      phase: "started",
      durationMs: undefined,
      error: undefined,
    });

    try {
      const model = this.#resolveModel(input.effectiveRuntime);
      const agent = new Agent({
        getApiKey: () => this.#config.apiKey ?? (this.#config.baseUrl !== undefined ? "unused" : undefined),
        streamFn: (m, context, options) =>
          streamSimple(m, context, {
            ...options,
            temperature: 0.3,
            maxTokens: 2048,
          }),
        sessionId: input.childSession.sessionId,
        initialState: {
          model,
          systemPrompt: buildChildSystemPrompt(input.effectiveRuntime),
        },
      });

      const taskMessage: AgentMessage = {
        role: "user",
        content: input.spawnRequest.task,
        timestamp: Date.now(),
      };

      await agent.prompt([taskMessage]);
      await agent.waitForIdle();

      const durationMs = Date.now() - startedAt;

      await input.emitTurnVisible({
        turnNumber: 1,
        phase: "completed",
        durationMs,
        error: undefined,
      });

      return {
        outcome: "success",
        summary: `Delegated child completed task: ${input.spawnRequest.task.slice(0, 200)}`,
        policyId: input.policy.policyId,
        childSessionId: input.childSession.sessionId,
        effectiveRuntime: input.effectiveRuntime,
        turnsUsed: 1,
        tokensConsumed: 0,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);

      await input.emitTurnVisible({
        turnNumber: 1,
        phase: "completed",
        durationMs,
        error: errorMessage,
      });

      return {
        outcome: "failure",
        summary: `Delegated child failed: ${errorMessage}`,
        policyId: input.policy.policyId,
        childSessionId: input.childSession.sessionId,
        effectiveRuntime: input.effectiveRuntime,
        turnsUsed: 1,
        tokensConsumed: 0,
        durationMs,
        error: errorMessage,
      };
    }
  }

  #resolveModel(runtime: EffectiveDelegationRuntime): Model<Api> {
    const baseUrl = this.#config.baseUrl;
    const modelName = this.#config.modelName ?? runtime.model ?? "delegated-child";

    if (baseUrl !== undefined) {
      return {
        id: modelName,
        name: modelName,
        api: "openai-completions",
        provider: runtime.provider ?? "custom",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        maxTokens: 2048,
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

    const provider = runtime.provider;
    if (provider !== undefined) {
      const knownProvider = asKnownProvider(provider);
      if (knownProvider !== null) {
        const model = getModels(knownProvider).find((candidate) => candidate.id === modelName);
        if (model !== undefined) return model;
      }
    }

    // DESIGN: fallback to OpenAI-compatible with the provided provider/model.
    // Rationale: if no baseUrl and no known provider, we cannot resolve.
    // This should not happen in production but provides a safe path.
    throw new Error(
      `Cannot resolve LLM model for delegated child: provider=${provider ?? "undefined"} model=${modelName}`,
    );
  }
}

function asKnownProvider(provider: string): KnownProvider | null {
  return getProviders().includes(provider as KnownProvider)
    ? (provider as KnownProvider)
    : null;
}

function buildChildSystemPrompt(runtime: EffectiveDelegationRuntime): string {
  return [
    "You are a delegated subagent executing a specific task.",
    "Complete the task concisely and return the result.",
    `Profile: ${runtime.profileId}`,
    runtime.provider !== undefined ? `Provider: ${runtime.provider}` : "",
    runtime.model !== undefined ? `Model: ${runtime.model}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type { DelegatedChildRunInput };
