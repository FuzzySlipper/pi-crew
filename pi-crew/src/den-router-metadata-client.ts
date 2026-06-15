/** Den Router model metadata client for full-agent context policy. */
import type { Logger } from "@pi-crew/core";
import type { FullAgentContextPolicy, ContextLengthSource } from "@pi-crew/service";
import type { CrewConfig } from "./config.js";

export interface DenRouterModelMetadata {
  readonly contextLength: number | null;
  readonly source: ContextLengthSource;
}

export interface DenRouterMetadataClientConfig {
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

interface MetadataResponse {
  readonly context_length?: unknown;
  readonly contextLength?: unknown;
  readonly source?: unknown;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class DenRouterMetadataClient {
  readonly #baseUrl: string;
  readonly #fetchFn: typeof fetch;
  readonly #timeoutMs: number;
  readonly #logger: Logger | null;

  constructor(config: DenRouterMetadataClientConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = config.logger ?? null;
  }

  async modelMetadata(modelId: string): Promise<DenRouterModelMetadata | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetchFn(
        `${this.#baseUrl}/models/${encodeURIComponent(modelId)}/metadata`,
        { method: "GET", signal: controller.signal },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as MetadataResponse;
      const contextLength =
        positiveInteger(body.context_length) ?? positiveInteger(body.contextLength);
      return {
        contextLength: contextLength ?? null,
        source:
          body.source === "default"
            ? "config-default"
            : body.source === "unknown"
              ? "unknown-default"
              : "den-router",
      };
    } catch (error: unknown) {
      this.#logger?.warn("den_router.metadata_lookup_failed", {
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface FullAgentContextPolicyResolverConfig {
  readonly crewContext: CrewConfig["context"];
  readonly provider: string;
  readonly modelName: string;
  readonly modelBaseUrl?: string;
  readonly logger?: Logger;
  readonly fetchFn?: typeof fetch;
}

export function createFullAgentContextPolicyResolver(
  config: FullAgentContextPolicyResolverConfig,
): () => Promise<FullAgentContextPolicy> {
  let cached: Promise<FullAgentContextPolicy> | null = null;
  return () => {
    cached ??= resolveFullAgentContextPolicy(config);
    return cached;
  };
}

export async function resolveFullAgentContextPolicy(
  config: FullAgentContextPolicyResolverConfig,
): Promise<FullAgentContextPolicy> {
  if (config.provider === "den-router" && config.modelBaseUrl !== undefined) {
    const metadata = await new DenRouterMetadataClient({
      baseUrl: config.modelBaseUrl,
      logger: config.logger,
      fetchFn: config.fetchFn,
    }).modelMetadata(config.modelName);
    if (metadata?.contextLength !== null && metadata?.contextLength !== undefined) {
      return {
        contextLength: metadata.contextLength,
        contextLengthSource: "den-router",
        thresholdPercent: config.crewContext.compactionThresholdPercent,
        minimumRecentMessages: config.crewContext.minimumRecentMessages,
      };
    }
  }
  return {
    contextLength: config.crewContext.defaultContextLength,
    contextLengthSource: "config-default",
    thresholdPercent: config.crewContext.compactionThresholdPercent,
    minimumRecentMessages: config.crewContext.minimumRecentMessages,
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
