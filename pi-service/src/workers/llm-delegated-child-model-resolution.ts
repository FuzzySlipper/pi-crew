/** Resolve model metadata for LLM-backed delegated children. */

import {
  getModels,
  getProviders,
  type Api,
  type KnownProvider,
  type Model,
} from "@earendil-works/pi-ai";
import type { EffectiveDelegationRuntime } from "@pi-crew/core";

export interface DelegatedChildModelResolutionConfig {
  readonly baseUrl?: string;
  readonly modelName?: string;
}

export class DelegatedChildModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegatedChildModelResolutionError";
  }
}

export function resolveDelegatedChildModel(
  runtime: EffectiveDelegationRuntime,
  config: DelegatedChildModelResolutionConfig,
): Model<Api> {
  const baseUrl = config.baseUrl;
  // DESIGN: Prefer the child runtime's model over the legacy global delegation
  // fallback. Rationale: delegated coder/reviewer profiles need independent
  // model selection; a service-level default must not silently override them.
  const modelName = runtime.model ?? config.modelName ?? "delegated-child";

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

  throw new DelegatedChildModelResolutionError(
    `Cannot resolve LLM model for delegated child: provider=${provider ?? "undefined"} model=${modelName}`,
  );
}

function asKnownProvider(provider: string): KnownProvider | null {
  return getProviders().includes(provider as KnownProvider) ? (provider as KnownProvider) : null;
}
