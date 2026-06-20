/**
 * Routing assembly builder — session manager, instance pool, delegation
 * lifecycle, extensions, and background review.
 *
 * Fifth in the dependency chain: requires infra, persistence, mcp,
 * and den-channel assemblies.
 *
 * @module pi-crew/routing-assembly
 */

import type { Logger, EventBus, ChannelProvider, AgentWorkBreadcrumbRepository } from "@pi-crew/core";
import {
  ConfigurationError,
  InMemoryHookRegistry,
} from "@pi-crew/core";
import {
  SessionManagerImpl,
  AgentFactoryImpl,
  InstancePoolImpl,
  InstanceFactoryImpl,
  SessionPresenceBridge,
  FullSessionResetService,
  DelegatedSpawnLifecycle,
  DelegatedChildRegistry,
  DelegatedOrphanCleanup,
  SessionManagerDelegationSessionBridge,
  SqlitePendingChildRepository,
  AgentRuntimeRegistry,
  DenDelegationProjectionExtension,
  ParentLifecycleBreadcrumbExtension,
  ToolPolicyExtension,
  ExtensionActivator,
  createServiceExtensionContext,
  ScriptCronJobExecutor,
  CronScheduler,
  type ExtensionConfigReloadOutcome,
  type WorkerRuntimeConfig,
  type WorkerRoleMappingConfig,
  type SessionConfig,
  type ServiceRegistry,
  MessageRepositoryTurnHistory,
} from "@pi-crew/service";
import { BreadcrumbManager, AuditLogger } from "@pi-crew/governance";
import { ToolPolicyEnforcer } from "@pi-crew/tools";
import { loadProfile } from "@pi-crew/profiles";
import { buildRuntimeResponderFactory } from "./runtime-responder-factory.js";
import { SessionKindAwareResponderFactory } from "./session-kind-responder-factory.js";
import {
  createDeferredDelegationLifecyclePort,
  createDelegatedChildRunner,
} from "./delegation-composition.js";
import {
  configureFullSessionManager,
  resolveAgentFields,
} from "./full-agent-sessions.js";
import {
  createFallbackChannelBinding,
  validateCrewConfig,
  auditEntryToRecord,
} from "./crew-helpers.js";
import { createCrewAgentWorkerExecutor } from "./agent-worker-executor-factory.js";
import { createDenAdminEvidencePoster } from "./den-admin-evidence-poster.js";
import { createCuratorHandler } from "./curator-router.js";
import { DefaultCuratorService, type CuratorService } from "./curator-service.js";
import { DefaultMcpSurfaceManager, type McpSurfaceManager } from "./mcp-surface-manager.js";
import { BackgroundReviewRunner } from "./background-review-runner.js";
import { type CrewConfig, resolveCrewInstallLayout } from "./config.js";
import { syncConfiguredCronJobs } from "./cron-jobs.js";
import { SteerFollowUpBridge } from "./steer-followup-bridge.js";
import { ChannelRouter } from "./channel-router.js";
import { ServiceWorkConsumer, type ServiceWorkConsumer } from "./service-work-consumer.js";
import type { InfraAssembly } from "./infra-assembly.js";
import type { PersistenceAssembly } from "./persistence-assembly.js";
import type { McpAssembly } from "./mcp-assembly.js";
import type { DenChannelAssembly } from "./den-channel-assembly.js";
import { ObservationClient } from "./observation/observation-client.js";
import { ObservationEmitter } from "./observation/observation-emitter.js";
import { hostname } from "node:os";

export interface RoutingAssembly {
  readonly sessionManager: SessionManagerImpl;
  readonly instancePool: InstancePoolImpl;
  readonly agentRegistry: AgentRuntimeRegistry;
  readonly steerFollowUpBridge: SteerFollowUpBridge;
  readonly extensionActivator: ExtensionActivator;
  readonly delegatedSpawnLifecycle: DelegatedSpawnLifecycle;
  readonly breadcrumbManager: BreadcrumbManager;
  readonly auditLogger: AuditLogger;
  readonly toolPolicyEnforcer: ToolPolicyEnforcer;
  readonly backgroundReviewUnsubscribers: (() => void)[];
  readonly serviceWorkConsumer: ServiceWorkConsumer;
  readonly curator: CuratorService | null;
  readonly curatorHandler: ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>) | null;
  readonly observationEmitter: ObservationEmitter | null;
}

export interface RoutingAssemblyDeps {
  readonly infra: InfraAssembly;
  readonly persistence: PersistenceAssembly;
  readonly mcp: McpAssembly;
  readonly channel: DenChannelAssembly;
  readonly mcpSurfaceManager: McpSurfaceManager;
}

export function setupRouting(deps: RoutingAssemblyDeps): RoutingAssembly {
  const { infra, persistence, mcp, channel, mcpSurfaceManager } = deps;
  const { config, logger, eventBus, registry, gateway } = infra;
  const {
    sessionStore,
    messageRepository,
    auditRepository,
    agentWorkBreadcrumbRepository,
    counterService,
    denseMemoryStore,
    cursorStore,
    cronRepository,
  } = persistence;
  const {
    mcpClient,
    mcpToolRegistry,
    mcpSurfaceManager: mcpSurfaceManagerFromMcp,
    denCompletionPoster,
    backgroundReviewRunner,
    cronScheduler,
  } = mcp;
  const { channelProvider, perAgentProviders, additionalProviders, channelRouter } = channel;

  const profilesRoot = resolveCrewInstallLayout(config).profilesRoot;

  // ── Responder & instance pool ───────────────────────────────
  const fullAgentDelegationLifecycle = createDeferredDelegationLifecyclePort();
  const fullAgentFactory = buildRuntimeResponderFactory(
    config,
    eventBus,
    logger,
    mcpSurfaceManager,
    new MessageRepositoryTurnHistory(messageRepository, { eventBus }), // wrapped below
    { lifecycle: fullAgentDelegationLifecycle.port },
    { baseUrl: config.den.channelsUrl, token: config.den.channelsToken },
    messageRepository,
    counterService,
    denseMemoryStore,
  );
  const responderFactory = new SessionKindAwareResponderFactory(fullAgentFactory);
  const instanceFactory = new InstanceFactoryImpl(logger, responderFactory);
  const instancePool = new InstancePoolImpl(
    instanceFactory,
    {
      maxPerProfile: config.sessions.maxPerProfile,
      maxTotal: config.sessions.maxTotal,
      idleTimeoutMs: config.sessions.idleTimeoutMs,
    },
    logger,
  );
  const agentFactory = new AgentFactoryImpl(
    instancePool,
    sessionStore,
    eventBus,
    logger,
  );

  // ── Session manager ─────────────────────────────────────────
  const sessionManager = new SessionManagerImpl(
    sessionStore,
    agentFactory,
    instancePool,
    eventBus,
    logger,
    config.sessions.fallbackProfileId,
    createFallbackChannelBinding(config),
  );
  configureFullSessionManager(sessionManager, config, profilesRoot);

  // ── Agent registry & steer bridge ───────────────────────────
  const agentRegistry = new AgentRuntimeRegistry();
  const steerFollowUpBridge = new SteerFollowUpBridge(agentRegistry, logger);

  // ── Delegation lifecycle ────────────────────────────────────
  const delegationBridge = new SessionManagerDelegationSessionBridge({
    sessionManager,
    sessionStore,
    eventBus,
    logger,
  });
  const pendingChildRepository = persistence.pendingChildRepository;
  const childRegistry = new DelegatedChildRegistry({
    repository: pendingChildRepository,
    eventBus,
    logger,
  });
  void childRegistry.recoverPending({ activeChildSessionIds: [] });
  const delegatedSpawnLifecycle = new DelegatedSpawnLifecycle({
    hookRegistry: registry.hookRegistry,
    delegationSessions: delegationBridge,
    eventBus,
    logger,
    childRunner: createDelegatedChildRunner(config.delegation, {
      mcpClient,
      toolRegistry: mcpToolRegistry,
      profilesRoot,
      streamRetry: config.streamRetry,
      eventBus,
    }),
    childRegistry,
  });
  fullAgentDelegationLifecycle.set(delegatedSpawnLifecycle);
  new DelegatedOrphanCleanup({
    delegationSessions: delegationBridge,
    eventBus,
    logger,
  }).activate();

  // ── Extensions ──────────────────────────────────────────────
  const extensionActivator = new ExtensionActivator({
    extensions: [
      new ToolPolicyExtension(registry.toolPolicySessionRegistry),
      new DenDelegationProjectionExtension({
        channelProvider,
        channelId: config.den.channelsSubscriptionChannelId,
        channelEnabled: config.delegation.projection.channelEnabled,
        localLogEnabled: config.delegation.projection.localLogEnabled,
        localLogPath:
          config.delegation.projection.localLogPath ??
          `${config.install.root}/delegation-projections.log`,
        projectToolCalledEvents: config.delegation.projection.projectToolCalledEvents,
        breadcrumbRepository: agentWorkBreadcrumbRepository,
        projectId: config.den.channelsProjectId,
        parentAgentIdentity: config.agent.identity,
      }),
      new ParentLifecycleBreadcrumbExtension({
        repository: agentWorkBreadcrumbRepository,
        logger,
        bindings: config.fullAgents.filter((agent) => agent.enabled).map((agent) => {
          const resolved = resolveAgentFields(agent, profilesRoot);
          return {
            sessionId: resolved.sessionId,
            channelId: agent.channels[0]?.channelId ?? config.den.channelsSubscriptionChannelId,
            projectId: agent.channels[0]?.projectId ?? config.den.channelsProjectId,
            agentIdentity: resolved.memberIdentity,
            profileId: agent.profileId,
            provider: agent.runtime.provider,
            model: agent.runtime.model,
          } as const;
        }),
      }),
    ],
    context: createServiceExtensionContext({
      config: registry.config,
      logger: registry.logger,
      eventBus: registry.eventBus,
      hookRegistry: registry.hookRegistry,
      delegationSessions: delegationBridge,
    }),
  });

  // ── Presence bridge & provider onMessage wiring ────────────
  new SessionPresenceBridge(eventBus, channelProvider, logger);

  // ── Breadcrumb, audit, policy ───────────────────────────────
  const breadcrumbManager = new BreadcrumbManager(eventBus, channelProvider, logger);
  const auditLogger = new AuditLogger(eventBus, logger, {
    writer: (entry) => {
      void auditRepository.write({
        sessionId: entry.correlation.sessionId,
        assignmentId: entry.correlation.assignmentId?.toString(),
        eventType: entry.event,
        eventData: auditEntryToRecord(entry),
      });
    },
  });
  const toolPolicyEnforcer = new ToolPolicyEnforcer(eventBus, logger);

  // ── Service work consumer ───────────────────────────────────
  if (config.backgroundReview.enabled && !config.backgroundReview.serviceWorkUrl) {
    throw new ConfigurationError(
      "backgroundReview.serviceWorkUrl is required when backgroundReview.enabled is true",
    );
  }

  const serviceWorkConsumer = new ServiceWorkConsumer(
    logger,
    eventBus,
    channelProvider,
    {
      baseUrl: config.backgroundReview.serviceWorkUrl ?? "",
      channelId: config.backgroundReview.serviceWorkChannel,
      claimTTLMs: config.backgroundReview.triggerClaimTTLMs,
      enabled: config.backgroundReview.enabled,
      agentIdentity: config.agent.identity,
      pollIntervalMs: config.backgroundReview.pollIntervalMs,
      pollLimit: config.backgroundReview.pollLimit,
      startupDelayMs: config.backgroundReview.startupDelayMs,
    },
  );

  // ── Background review event subscriptions ───────────────────
  const backgroundReviewUnsubscribers: (() => void)[] = [];
  if (config.backgroundReview.enabled) {
    backgroundReviewUnsubscribers.push(
      eventBus.on("turn.completed", (payload) => {
        if (config.backgroundReview.enabled) handleTurnCompleted(payload, config, counterService, channelProvider, backgroundReviewRunner, logger);
      }),
      eventBus.on("tool.called", (payload) => {
        if (config.backgroundReview.enabled && payload.profileId !== undefined) {
          void counterService.incrementIteration(payload.profileId, payload.sessionId);
        }
      }),
      eventBus.on("service_work.trigger_claimed", (payload) => {
        if (!config.backgroundReview.enabled) return;
        void handleTriggerClaimed(payload, counterService, backgroundReviewRunner, logger);
      }),
    );
  }

  // ── Curator maintenance ────────────────────────────────────
  let curator: CuratorService | null = null;
  if (config.curator.enabled) {
    curator = new DefaultCuratorService(
      { ...config.curator, installRoot: config.install.root },
      logger,
      config.curator.minTickMs,
    );
    cronRepository.upsert({
      id: "curator-maintenance",
      projectId: config.agent.projectId,
      schedule: config.curator.cronSchedule,
      shape: "script_only",
      script: "",
      cwd: null,
      deliveryChannelId: null,
      enabled: true,
      timezone: "UTC",
    }, new Date()).catch((error: unknown) => {
      logger.warn("Failed to register curator cron job", { error: String(error) });
    });
    logger.info("Curator maintenance cron job registered", {
      schedule: config.curator.cronSchedule,
      dryRun: config.curator.dryRun,
    });

    // Start internal auto-scheduler
    curator.startAutoScheduler();
  }

  // Register curator HTTP routes on the Gateway
  const curatorHandler = curator !== null
    ? createCuratorHandler({ curator, logger })
    : null;

  if (curatorHandler !== null) {
    gateway.addRouteHandler((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/v1/curator/")) return false;
      curatorHandler(req, res).catch((err) => {
        logger.error("Curator route handler error", { error: String(err) });
      });
      return true;
    });

    // Register a curator-aware health endpoint on /health
    gateway.addRouteHandler(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/health" && url.pathname !== "/") return false;
      const curatorStatus = await curator!.status().catch(() => null);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        curator: curatorStatus
          ? {
              enabled: true,
              paused: curatorStatus.paused,
              lastRunAt: curatorStatus.lastRunAt,
              lastRunSummary: curatorStatus.lastRunSummary,
              runCount: curatorStatus.runCount,
            }
          : { enabled: true, paused: false },
      }));
      return true;
    });
  }

  // ── Log summary ─────────────────────────────────────────────
  logger.info("Crew composition root assembled", {
    config: {
      denCoreUrl: config.den.coreUrl,
      mcpEndpoint: config.mcp.endpoint,
      dbPath: config.database.path,
      sessions: config.sessions,
    },
  });

  // ── Observation emitter ────────────────────────────────────
  let observationEmitter: ObservationEmitter | null = null;
  if (config.den.observationUrl !== undefined && config.den.observationUrl.length > 0) {
    const obsClient = new ObservationClient(
      { baseUrl: config.den.observationUrl },
      logger,
    );
    observationEmitter = new ObservationEmitter(
      obsClient,
      eventBus,
      logger,
      config.agent.identity,
      `${config.agent.identity}@${hostname()}`,
    );
    observationEmitter.start();

    // Emit runtime-started observation event
    observationEmitter.client.post({
      sourceDomain: "runtime",
      eventType: "agent_session_started",
      agentIdentity: {
        profile: config.agent.identity,
        instanceId: `${config.agent.identity}@${hostname()}`,
      },
      payload: {
        kind: "agent_activity.v1",
        schemaVersion: 1,
        summary: `${config.agent.identity} runtime started`,
        severity: "info",
        visibility: "channel",
        adapter: "pi-crew",
        surface: "runtime",
      },
    });

    logger.info("Observation emitter enabled", {
      observationUrl: config.den.observationUrl,
    });
  } else {
    logger.info("Observation emitter disabled (no observationUrl configured)");
  }

  return {
    sessionManager,
    instancePool,
    agentRegistry,
    steerFollowUpBridge,
    extensionActivator,
    delegatedSpawnLifecycle,
    breadcrumbManager,
    auditLogger,
    toolPolicyEnforcer,
    backgroundReviewUnsubscribers,
    serviceWorkConsumer,
    curator,
    curatorHandler,
    observationEmitter,
  };
}

// ── Background review event handlers ──────────────────────────────

function handleTurnCompleted(
  payload: { readonly sessionId: string; readonly profileId: string | undefined; readonly turnNumber: number; readonly durationMs: number },
  config: CrewConfig,
  counterService: import("@pi-crew/service").CounterService,
  channelProvider: ChannelProvider,
  backgroundReviewRunner: BackgroundReviewRunner,
  logger: Logger,
): void {
  const profileId = payload.profileId;
  if (profileId === undefined) return;

  void counterService.incrementTurn(profileId, payload.sessionId).catch((error: unknown) => {
    logger.warn("Background review turn increment failed", {
      profileId,
      sessionId: payload.sessionId,
      error: String(error),
    });
  });

  let memoryNudgeInterval = config.backgroundReview.defaultMemoryNudgeInterval;
  let skillNudgeInterval = config.backgroundReview.defaultSkillNudgeInterval;
  let enabledOverride: boolean | undefined;
  try {
    const profile = loadProfile(profileId, resolveCrewInstallLayout(config).profilesRoot);
    if (profile.backgroundReview !== undefined) {
      if (profile.backgroundReview.enabled !== undefined) {
        enabledOverride = profile.backgroundReview.enabled;
      }
      if (profile.backgroundReview.memoryNudgeInterval !== undefined) {
        memoryNudgeInterval = profile.backgroundReview.memoryNudgeInterval;
      }
      if (profile.backgroundReview.skillNudgeInterval !== undefined) {
        skillNudgeInterval = profile.backgroundReview.skillNudgeInterval;
      }
    }
  } catch {
    // Profile not found — continue with defaults
  }
  if (enabledOverride === false) return;

  void counterService
    .checkTrigger(profileId, payload.sessionId, {
      memoryNudgeInterval,
      skillNudgeInterval,
    })
    .then((trigger) => {
      if (trigger === null) return;
      const triggerMessage = JSON.stringify({
        type: "background_review_trigger",
        profileId,
        sessionId: payload.sessionId,
        triggerType: trigger.type,
        turnsSinceMemory: trigger.turnsSinceMemory,
        itersSinceSkill: trigger.itersSinceSkill,
      });
      void channelProvider
        .sendMessage(config.backgroundReview.serviceWorkChannel, {
          kind: "text",
          text: triggerMessage,
        })
        .then(() => {
          logger.info("Background review trigger posted", {
            profileId,
            sessionId: payload.sessionId,
            triggerType: trigger.type,
            channelId: config.backgroundReview.serviceWorkChannel,
          });
        })
        .catch((error: unknown) => {
          logger.warn("Background review trigger post failed", {
            profileId,
            sessionId: payload.sessionId,
            triggerType: trigger.type,
            channelId: config.backgroundReview.serviceWorkChannel,
            error: String(error),
          });
        });
    })
    .catch((error: unknown) => {
      logger.warn("Background review checkTrigger failed", {
        profileId,
        sessionId: payload.sessionId,
        error: String(error),
      });
    });
}

function handleTriggerClaimed(
  payload: { readonly profileId: string; readonly sessionId: string; readonly triggerType: string; readonly reviewId: string },
  counterService: import("@pi-crew/service").CounterService,
  backgroundReviewRunner: BackgroundReviewRunner,
  logger: Logger,
): void {
  void counterService
    .resetCounter(payload.profileId, payload.sessionId, payload.triggerType as "memory" | "skill" | "combined")
    .then(() => {
      logger.info("Background review counter reset after trigger claim", {
        reviewId: payload.reviewId,
        profileId: payload.profileId,
        sessionId: payload.sessionId,
        triggerType: payload.triggerType,
      });
      void backgroundReviewRunner.runReview({
        profileId: payload.profileId,
        sessionId: payload.sessionId,
        triggerType: payload.triggerType as "memory" | "skill" | "combined",
        reviewId: payload.reviewId,
      }).catch((error: unknown) => {
        logger.error("Background review runner error", {
          reviewId: payload.reviewId,
          error: String(error),
        });
      });
    })
    .catch((error: unknown) => {
      logger.warn("Background review counter reset failed", {
        reviewId: payload.reviewId,
        profileId: payload.profileId,
        sessionId: payload.sessionId,
        error: String(error),
      });
    });
}
