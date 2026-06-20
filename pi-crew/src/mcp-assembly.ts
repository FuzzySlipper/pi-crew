/**
 * MCP assembly builder — MCP client, tool registry, surface manager,
 * diagnostics, completion poster, and background review runner.
 *
 * Third in the dependency chain: requires infra for config/logger/eventBus,
 * and persistence for runtimeDb/sessionStore/cursorStore/counterService.
 *
 * @module pi-crew/mcp-assembly
 */

import type { Logger, EventBus, AgentWorkBreadcrumbRepository, ChannelProvider } from "@pi-crew/core";
import type { CompletionPoster } from "@pi-crew/tools";
import { ScriptCronJobExecutor, CronScheduler, type CronJobRepository, type CounterService } from "@pi-crew/service";
import { MCPClient, ToolRegistry as McpToolRegistry, type ServerConfig } from "@pi-crew/mcp";
import { createCrewDiagnostics } from "./crew-diagnostics.js";
import { createDenCompletionPoster } from "./den-completion-poster.js";
import { DefaultMcpSurfaceManager, type McpSurfaceManager } from "./mcp-surface-manager.js";
import { BackgroundReviewRunner, type BackgroundReviewRunnerConfig } from "./background-review-runner.js";
import type { InfraAssembly } from "./infra-assembly.js";
import type { PersistenceAssembly } from "./persistence-assembly.js";
import { completionDefaultsFromEnv } from "./crew-helpers.js";
import type { CrewConfig } from "./config.js";

export interface McpAssembly {
  readonly mcpClient: MCPClient;
  readonly mcpToolRegistry: McpToolRegistry;
  readonly mcpSurfaceManager: McpSurfaceManager;
  readonly denCompletionPoster: CompletionPoster;
  readonly backgroundReviewRunner: BackgroundReviewRunner;
  readonly diagnostics: ReturnType<typeof createCrewDiagnostics>;
  readonly cronScheduler: CronScheduler | null;
}

export interface McpAssemblyDeps {
  readonly infra: InfraAssembly;
  readonly persistence: PersistenceAssembly;
  /** Channel provider needed for diagnostics event bus wiring and background review. */
  readonly channelProvider: ChannelProvider;
  readonly agentWorkBreadcrumbRepository: AgentWorkBreadcrumbRepository;
}

export function setupMcp(deps: McpAssemblyDeps): McpAssembly {
  const { infra, persistence, channelProvider } = deps;
  const { config, logger, eventBus } = infra;
  const { runtimeDb, sessionStore, cursorStore, counterService, cronRepository } = persistence;

  const mcpClient = new MCPClient(logger, eventBus);
  const mcpToolRegistry = new McpToolRegistry(logger);
  const mcpSurfaceManager = new DefaultMcpSurfaceManager({
    config: config.mcp,
    logger,
    eventBus,
  });

  const diagnostics = createCrewDiagnostics({
    eventBus,
    runtimeDb,
    sessionStore,
    channelProvider,
    mcpClient,
    denCoreUrl: config.den.coreUrl,
  });

  const denCompletionPoster = createDenCompletionPoster({
    mcpClient,
    projectId: config.agent.projectId,
    requestedBy: config.agent.identity,
    logger,
    completionDefaults: completionDefaultsFromEnv(process.env),
    retryMaxAttempts: config.delegation.completionRetryMaxAttempts,
    retryBaseDelayMs: config.delegation.completionRetryBaseDelayMs,
    retryMaxDelayMs: config.delegation.completionRetryMaxDelayMs,
  });

  const cronScheduler = config.cron.enabled
    ? new CronScheduler({
        repository: cronRepository,
        executor: new ScriptCronJobExecutor({
          scriptRoot: config.cron.scriptRoot,
          channelProvider,
          logger,
        }),
        logger,
        eventBus,
        tickIntervalMs: config.cron.tickIntervalMs,
        staleRunAfterMs: config.cron.staleRunAfterMs,
      })
    : null;

  const backgroundReviewRunner = config.backgroundReview.enabled
    ? new BackgroundReviewRunner({
        eventBus,
        logger,
        channelProvider,
        denseMemoryStore: persistence.denseMemoryStore,
        config: config as unknown as BackgroundReviewRunnerConfig,
        denRouterUrl: config.backgroundReview.llm.denRouterUrl,
      })
    : (null as unknown as BackgroundReviewRunner);

  return {
    mcpClient,
    mcpToolRegistry,
    mcpSurfaceManager,
    denCompletionPoster,
    backgroundReviewRunner,
    diagnostics,
    cronScheduler,
  };
}
