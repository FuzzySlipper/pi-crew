import type { Logger, EventBus, ChannelProvider, AgentWorkBreadcrumbRepository } from "@pi-crew/core";
import { ConfigurationError, FakeEventBus, FakeLogger, InMemoryHookRegistry } from "@pi-crew/core";
import { DenChannelsAdapter } from "@pi-crew/channels/den-channels/den-channels-adapter";
import type { DenChannelsAdapterConfig } from "@pi-crew/channels/den-channels/den-channels-adapter";
import { createAdditionalChannelProviders } from "./channel-provider-factory.js";
import {
  loadConfig,
  Gateway,
  createServiceRegistry,
  SessionManagerImpl,
  SessionPresenceBridge,
  AgentFactoryImpl,
  InstancePoolImpl,
  InstanceFactoryImpl,
  RuntimeDb,
  AdminServer,
  DirectDebugSessionService, DirectDebugContextService,
  FullSessionResetService,
  RemediationControlService,
  ExtensionActivator,
  createServiceExtensionContext,
  InMemoryToolPolicySessionRegistry,
  ToolPolicyExtension,
  AgentRuntimeRegistry,
  DelegatedSpawnLifecycle,
  DelegatedChildRegistry,
  DenDelegationProjectionExtension,
  DelegatedOrphanCleanup,
  WorkerRuntime,
  SessionManagerDelegationSessionBridge,
  SqliteAuditRepository,
  SqlitePendingChildRepository,
  SqliteAgentWorkBreadcrumbRepository,
  HttpAgentWorkLifecyclePublisher, PublishingAgentWorkBreadcrumbRepository,
  ParentLifecycleBreadcrumbExtension,
  SqliteSessionRepository,
  SqliteMessageRepository,
  MessageRepositoryTurnHistory,
  DefaultCounterService,
  SqliteCounterRepository,
  SqliteDenseProfileMemoryStore,
  type GatewayConfig,
  type ServiceRegistry,
  type WorkerRoleMappingConfig,
  type WorkerRuntimeConfig,
  type AgentWorkerExecutor,
  type CounterService,
  CronScheduler,
  SqliteCronJobRepository,
  ScriptCronJobExecutor,
  type CronJobRepository,
} from "@pi-crew/service";
import {
  loadCrewConfig, CrewConfigSchema, resolveCrewInstallLayout, type CrewConfig,
  type CuratorConfig,
} from "./config.js";
export {
  CrewConfigSchema,
  loadCrewConfig,
  resolveCrewConfigPath,
  resolveCrewInstallLayout,
  tryLoadCrewConfigDegraded,
  type CrewConfig,
  type FullAgentConfig,
} from "./config.js";
import { MCPClient, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import type { ServerConfig } from "@pi-crew/mcp";
import { BreadcrumbManager, AuditLogger } from "@pi-crew/governance";
import { ToolPolicyEnforcer } from "@pi-crew/tools";
import { loadProfile, loadProfiles } from "@pi-crew/profiles";
import { buildDenConnection, createSqliteCursorStore } from "./den-connection-factory.js";
import { buildRuntimeResponderFactory } from "./runtime-responder-factory.js";
import { SessionKindAwareResponderFactory } from "./session-kind-responder-factory.js";
import { createDenCompletionPoster } from "./den-completion-poster.js";
import { createDenAssignmentRunner } from "./den-assignment-runner.js";
import { createDenPoolAssignmentConsumer } from "./den-pool-source.js";
import type { DenAssignmentRunner } from "./den-assignment-runner.js";
import type { DenPoolMemberConfig } from "./den-pool-source.js";
import { createCrewDiagnostics } from "./crew-diagnostics.js";
import { resolveFullAgentRuntime } from "./full-agent-runtime-assembly.js";
import { createDenAdminEvidencePoster } from "./den-admin-evidence-poster.js";
import { BackgroundReviewRunner } from "./background-review-runner.js";
import { DefaultMcpSurfaceManager, type McpSurfaceManager } from "./mcp-surface-manager.js";
import { SteerFollowUpBridge } from "./steer-followup-bridge.js";
import { routeMentionedAgent } from "./mention-router.js";
import { createCrewAgentWorkerExecutor } from "./agent-worker-executor-factory.js";
import {
  createDeferredDelegationLifecyclePort,
  createDelegatedChildRunner,
} from "./delegation-composition.js";
import {
  configureFullSessionManager,
  configuredFullAgentMemberIdentities,
  configuredFullAgentAdditionalProjectIds,
  resolveAgentFields,
  type ResolvedAgentFields,
} from "./full-agent-sessions.js";
import {
  auditEntryToRecord,
  completionDefaultsFromEnv,
  createFallbackChannelBinding,
  validateCrewConfig,
  validateGatewayConfig,
} from "./crew-helpers.js";
import type { CompletionPoster } from "@pi-crew/tools";
import type { ExtensionConfigReloadOutcome } from "@pi-crew/service";
import { syncConfiguredCronJobs } from "./cron-jobs.js";
import { ServiceWorkConsumer, type ServiceWorkConsumer } from "./service-work-consumer.js";
import { DefaultCuratorService, type CuratorService } from "./curator-service.js";
import { createCuratorHandler } from "./curator-router.js";
export class Crew {
  readonly #config: CrewConfig;
  readonly #gatewayConfig: GatewayConfig;
  readonly #logger: Logger;
  readonly #eventBus: EventBus;
  readonly #registry: ServiceRegistry;
  readonly #gateway: Gateway;
  readonly #adminServer: AdminServer | null;
  readonly #runtimeDb: RuntimeDb;
  readonly #auditRepository: SqliteAuditRepository;
  readonly #agentWorkBreadcrumbRepository: AgentWorkBreadcrumbRepository;
  readonly #workerRoleMapping: WorkerRoleMappingConfig;
  readonly #channelProvider: ChannelProvider;
  readonly #additionalProviders: ChannelProvider[];
  readonly #mcpClient: MCPClient;
  readonly #mcpToolRegistry: McpToolRegistry;
  readonly #mcpSurfaceManager: McpSurfaceManager;
  readonly #sessionManager: SessionManagerImpl;
  readonly #breadcrumbManager: BreadcrumbManager;
  readonly #auditLogger: AuditLogger;
  readonly #toolPolicyEnforcer: ToolPolicyEnforcer;
  readonly #denCompletionPoster: CompletionPoster;
  readonly #extensionActivator: ExtensionActivator;
  readonly #delegatedSpawnLifecycle: DelegatedSpawnLifecycle;
  readonly #agentRegistry: AgentRuntimeRegistry;
  readonly #steerFollowUpBridge: SteerFollowUpBridge;
  readonly #instancePool: InstancePoolImpl;
  readonly #cronRepository: CronJobRepository;
  readonly #cronScheduler: CronScheduler | null;
  readonly #counterService: CounterService;
  readonly #denseMemoryStore: SqliteDenseProfileMemoryStore;
  readonly #backgroundReviewUnsubscribers: (() => void)[];
  readonly #backgroundReviewRunner: BackgroundReviewRunner;
  readonly #serviceWorkConsumer: ServiceWorkConsumer;
  readonly #curator: CuratorService | null = null;
  #started = false;
  constructor(config: CrewConfig, logger?: Logger, eventBus?: EventBus) {
    this.#config = config;
    const profilesRoot = resolveCrewInstallLayout(config).profilesRoot;
    loadProfile(config.sessions.fallbackProfileId, profilesRoot);
    this.#workerRoleMapping = config.workers;
    this.#logger = logger ?? new FakeLogger();
    this.#eventBus = eventBus ?? new FakeEventBus();
    const hookRegistry = new InMemoryHookRegistry(this.#logger);
    const toolPolicySessions = new InMemoryToolPolicySessionRegistry();
    this.#gatewayConfig = loadConfig({
      admin: config.admin,
      database: config.database,
      den: config.den,
      health: config.health,
      logging: config.logging,
      runtime: config.runtime,
    });
    this.#registry = createServiceRegistry({
      config: this.#gatewayConfig,
      logger: this.#logger,
      eventBus: this.#eventBus,
      hookRegistry,
      toolPolicySessionRegistry: toolPolicySessions,
    });
    this.#gateway = new Gateway(
      this.#registry.config,
      this.#registry.logger,
      this.#registry.eventBus,
    );
    this.#runtimeDb = new RuntimeDb(config.database, this.#logger);
    const sessionStore = new SqliteSessionRepository(this.#runtimeDb.handle, this.#logger);

    // ── Background review counter service ─────────────────────────
    this.#counterService = new DefaultCounterService(
      new SqliteCounterRepository(this.#runtimeDb.handle),
    );
    this.#denseMemoryStore = new SqliteDenseProfileMemoryStore(
      this.#runtimeDb.handle,
      this.#logger,
      resolveCrewInstallLayout(config).profilesRoot,
    );
    this.#backgroundReviewUnsubscribers = [];
    this.#auditRepository = new SqliteAuditRepository(this.#runtimeDb.handle);
    const sqliteAgentWorkBreadcrumbRepository = new SqliteAgentWorkBreadcrumbRepository(this.#runtimeDb.handle);
    this.#agentWorkBreadcrumbRepository = new PublishingAgentWorkBreadcrumbRepository({
      inner: sqliteAgentWorkBreadcrumbRepository,
      publisher: new HttpAgentWorkLifecyclePublisher({
        baseUrl: config.den.channelsUrl, token: config.den.channelsToken, logger: this.#logger,
      }),
      logger: this.#logger,
    });
    const cursorStore = createSqliteCursorStore(this.#runtimeDb);
    const denConnection = buildDenConnection(
      config.den,
      this.#logger,
      cursorStore,
      configuredFullAgentMemberIdentities(config, profilesRoot),
      configuredFullAgentAdditionalProjectIds(config, profilesRoot, config.den.channelsProjectId),
    );
    this.#channelProvider = new DenChannelsAdapter(denConnection, this.#logger, {
      name: "Den Channels Gateway",
    } satisfies DenChannelsAdapterConfig);
    this.#cronRepository = new SqliteCronJobRepository(this.#runtimeDb.handle);
    this.#cronScheduler = config.cron.enabled ? new CronScheduler({
      repository: this.#cronRepository,
      executor: new ScriptCronJobExecutor({ scriptRoot: config.cron.scriptRoot, channelProvider: this.#channelProvider }),
      logger: this.#logger, eventBus: this.#eventBus, tickIntervalMs: config.cron.tickIntervalMs, staleRunAfterMs: config.cron.staleRunAfterMs,
    }) : null;
    this.#mcpClient = new MCPClient(this.#logger, this.#eventBus);
    this.#mcpToolRegistry = new McpToolRegistry(this.#logger);
    this.#mcpSurfaceManager = new DefaultMcpSurfaceManager({ config: config.mcp, logger: this.#logger, eventBus: this.#eventBus });

    // Create diagnostics AFTER channel provider and MCP client are available
    const diagnostics = createCrewDiagnostics({
      eventBus: this.#eventBus,
      runtimeDb: this.#runtimeDb,
      sessionStore,
      channelProvider: this.#channelProvider,
      mcpClient: this.#mcpClient,
      denCoreUrl: config.den.coreUrl,
    });
    this.#denCompletionPoster = createDenCompletionPoster({
      mcpClient: this.#mcpClient,
      projectId: config.agent.projectId,
      requestedBy: config.agent.identity,
      logger: this.#logger,
      completionDefaults: completionDefaultsFromEnv(process.env),
      retryMaxAttempts: config.delegation.completionRetryMaxAttempts,
      retryBaseDelayMs: config.delegation.completionRetryBaseDelayMs,
      retryMaxDelayMs: config.delegation.completionRetryMaxDelayMs,
    });
    this.#agentRegistry = new AgentRuntimeRegistry();
    this.#steerFollowUpBridge = new SteerFollowUpBridge(this.#agentRegistry, this.#logger);
    const fullAgentDelegationLifecycle = createDeferredDelegationLifecyclePort();
    const messageRepository = new SqliteMessageRepository(this.#runtimeDb.handle);
    const fullAgentFactory = buildRuntimeResponderFactory(
      config,
      this.#eventBus,
      this.#logger,
      this.#mcpSurfaceManager,
      new MessageRepositoryTurnHistory(messageRepository, { eventBus: this.#eventBus }),
      { lifecycle: fullAgentDelegationLifecycle.port },
      { baseUrl: config.den.channelsUrl, token: config.den.channelsToken }, messageRepository,
      this.#counterService,
      this.#denseMemoryStore,
    );
    const responderFactory = new SessionKindAwareResponderFactory(fullAgentFactory);
    const instanceFactory = new InstanceFactoryImpl(this.#logger, responderFactory);
    this.#instancePool = new InstancePoolImpl(
      instanceFactory,
      {
        maxPerProfile: config.sessions.maxPerProfile,
        maxTotal: config.sessions.maxTotal,
        idleTimeoutMs: config.sessions.idleTimeoutMs,
      },
      this.#logger,
    );
    const agentFactory = new AgentFactoryImpl(
      this.#instancePool,
      sessionStore,
      this.#eventBus,
      this.#logger,
    );
    this.#sessionManager = new SessionManagerImpl(
      sessionStore,
      agentFactory,
      this.#instancePool,
      this.#eventBus,
      this.#logger,
      config.sessions.fallbackProfileId,
      createFallbackChannelBinding(config),
    );
    configureFullSessionManager(this.#sessionManager, config, profilesRoot);
    const sessionResetService = new FullSessionResetService({
      sessionStore,
      instancePool: this.#instancePool,
      messageRepository,
      eventBus: this.#eventBus,
    });
    this.#adminServer = config.admin.enabled
      ? new AdminServer({
          config: this.#gatewayConfig.admin,
          diagnostics,
          directDebug: new DirectDebugSessionService({
            sessionManager: this.#sessionManager,
            diagnostics,
            resetSession: (request) => sessionResetService.reset(request),
            reloadMcp: (request) =>
              this.#mcpSurfaceManager.reloadForProfile(
                loadProfile(request.profileId, resolveCrewInstallLayout(this.#config).profilesRoot),
                request,
              ),
          }), debugContext: new DirectDebugContextService({ diagnostics, messages: messageRepository }),
          controls: new RemediationControlService({
            diagnostics,
            auditRepository: this.#auditRepository,
            eventBus: this.#eventBus,
            sessionStore,
            instancePool: this.#instancePool,
            evidencePoster: createDenAdminEvidencePoster({
              mcpClient: this.#mcpClient,
              projectId: config.agent.projectId,
              sender: config.agent.identity,
              logger: this.#logger,
            }),
            validateConfig: validateGatewayConfig,
            reloadConfig: (candidateConfig: unknown) =>
              this.#crewReloadConfig(candidateConfig),
          }),
          toolInventory: { projectTools: (sessionId) => this.#projectTools(sessionId) },
          agentWorkBreadcrumbs: this.#agentWorkBreadcrumbRepository,
        })
      : null;
    const delegationBridge = new SessionManagerDelegationSessionBridge({
      sessionManager: this.#sessionManager,
      sessionStore,
      eventBus: this.#eventBus,
      logger: this.#logger,
    });
    const childRegistry = new DelegatedChildRegistry({
      repository: new SqlitePendingChildRepository(this.#runtimeDb.handle),
      eventBus: this.#eventBus,
      logger: this.#logger,
    });
    void childRegistry.recoverPending({ activeChildSessionIds: [] });
    this.#delegatedSpawnLifecycle = new DelegatedSpawnLifecycle({
      hookRegistry: this.#registry.hookRegistry,
      delegationSessions: delegationBridge,
      eventBus: this.#eventBus,
      logger: this.#logger,
      childRunner: createDelegatedChildRunner(config.delegation, {
        mcpClient: this.#mcpClient,
        toolRegistry: this.#mcpToolRegistry,
        profilesRoot: resolveCrewInstallLayout(config).profilesRoot,
        streamRetry: config.streamRetry,
        eventBus: this.#eventBus,
      }),
      childRegistry,
    });
    fullAgentDelegationLifecycle.set(this.#delegatedSpawnLifecycle);
    new DelegatedOrphanCleanup({
      delegationSessions: delegationBridge,
      eventBus: this.#eventBus,
      logger: this.#logger,
    }).activate();
    this.#extensionActivator = new ExtensionActivator({
      extensions: [
        new ToolPolicyExtension(this.#registry.toolPolicySessionRegistry),
        new DenDelegationProjectionExtension({
          channelProvider: this.#channelProvider,
          channelId: config.den.channelsSubscriptionChannelId,
          channelEnabled: config.delegation.projection.channelEnabled,
          localLogEnabled: config.delegation.projection.localLogEnabled,
          localLogPath:
            config.delegation.projection.localLogPath ??
            `${config.install.root}/delegation-projections.log`,
          projectToolCalledEvents: config.delegation.projection.projectToolCalledEvents,
          breadcrumbRepository: this.#agentWorkBreadcrumbRepository,
          projectId: config.den.channelsProjectId,
          parentAgentIdentity: config.agent.identity,
        }),
        new ParentLifecycleBreadcrumbExtension({
          repository: this.#agentWorkBreadcrumbRepository,
          logger: this.#logger,
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
        config: this.#registry.config,
        logger: this.#registry.logger,
        eventBus: this.#registry.eventBus,
        hookRegistry: this.#registry.hookRegistry,
        delegationSessions: delegationBridge,
      }),
    });
    new SessionPresenceBridge(this.#eventBus, this.#channelProvider, this.#logger);
    this.#channelProvider.onMessage((message) => {
      if (this.#steerFollowUpBridge.route(message)) return Promise.resolve();
      const agents = this.#config.fullAgents
        .filter((a) => a.enabled)
        .map((a) => ({ memberIdentity: resolveAgentFields(a, profilesRoot).memberIdentity }));
      const routed = routeMentionedAgent(message, agents);
      return this.#sessionManager.routeMessage(this.#channelProvider, routed);
    });

    // ── Additional channel providers (e.g. Telegram) ──────────────
    // DESIGN: Additional providers are created after session manager is ready.
    // Rationale: onMessage handlers need the session manager for routing.
    this.#additionalProviders = createAdditionalChannelProviders(
      this.#config.channelProviders,
      { logger: this.#logger, eventBus: this.#eventBus },
    );
    for (const provider of this.#additionalProviders) {
      provider.onMessage((message) => {
        if (this.#steerFollowUpBridge.route(message)) return Promise.resolve();
        return this.#sessionManager.routeMessage(provider, message);
      });
    }

    this.#breadcrumbManager = new BreadcrumbManager(
      this.#eventBus,
      this.#channelProvider,
      this.#logger,
    );

    this.#auditLogger = new AuditLogger(this.#eventBus, this.#logger, {
      writer: (entry) => {
        void this.#auditRepository.write({
          sessionId: entry.correlation.sessionId,
          assignmentId: entry.correlation.assignmentId?.toString(),
          eventType: entry.event,
          eventData: auditEntryToRecord(entry),
        });
      },
    });

    this.#toolPolicyEnforcer = new ToolPolicyEnforcer(this.#eventBus, this.#logger);

    if (config.backgroundReview.enabled) {
      this.#logger.info("Background review counter tracking enabled", {
        memoryNudgeInterval: config.backgroundReview.defaultMemoryNudgeInterval,
        skillNudgeInterval: config.backgroundReview.defaultSkillNudgeInterval,
      });
    }

    // ── Background review runner ──────────────────────────────
    this.#backgroundReviewRunner = config.backgroundReview.enabled
      ? new BackgroundReviewRunner({
          eventBus: this.#eventBus,
          logger: this.#logger,
          channelProvider: this.#channelProvider,
          denseMemoryStore: this.#denseMemoryStore,
          config: config as unknown as BackgroundReviewRunner["config"],
          denRouterUrl: config.backgroundReview.llm.denRouterUrl,
        })
      : (null as unknown as BackgroundReviewRunner);

    // ── Event bus subscriptions ───────────────────────────────
    this.#backgroundReviewUnsubscribers = [
      this.#eventBus.on("turn.completed", (payload) => {
        if (!config.backgroundReview.enabled) return;
        if (payload.profileId === undefined) return;
        this.#handleTurnCompleted(payload, config);
      }),
      this.#eventBus.on("tool.called", (payload) => {
        if (!config.backgroundReview.enabled) return;
        if (payload.profileId === undefined) return;
        void this.#counterService.incrementIteration(payload.profileId, payload.sessionId);
      }),
      this.#eventBus.on("service_work.trigger_claimed", (payload) => {
        if (!config.backgroundReview.enabled) return;
        void this.#handleTriggerClaimed(payload);
      }),
    ];

    this.#logger.info("Crew composition root assembled", {
      config: {
        denCoreUrl: config.den.coreUrl,
        mcpEndpoint: config.mcp.endpoint,
        dbPath: config.database.path,
        sessions: config.sessions,
      },
    });

    // DESIGN: Validate serviceWorkUrl when background review is enabled.
    // Rationale: No hardcoded fallback — explicit failure is better than silent misconfiguration.
    if (config.backgroundReview.enabled && !config.backgroundReview.serviceWorkUrl) {
      throw new ConfigurationError(
        "backgroundReview.serviceWorkUrl is required when backgroundReview.enabled is true",
      );
    }

    this.#serviceWorkConsumer = new ServiceWorkConsumer(
      this.#logger,
      this.#eventBus,
      this.#channelProvider,
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

    // ── Curator maintenance ───────────────────────────────────────
    if (config.curator.enabled) {
      const curator = new DefaultCuratorService(
        { ...config.curator, installRoot: config.install.root },
        this.#logger,
        config.curator.minTickMs,
      );
      this.#cronRepository.upsert({
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
        this.#logger.warn("Failed to register curator cron job", { error: String(error) });
      });
      this.#logger.info("Curator maintenance cron job registered", {
        schedule: config.curator.cronSchedule,
        dryRun: config.curator.dryRun,
      });

      // Start internal auto-scheduler for periodic curator passes
      curator.startAutoScheduler();

      // Register curator HTTP diagnostic routes on the Gateway health server
      const curatorHandler = createCuratorHandler({ curator, logger: this.#logger });
      this.#gateway.addRouteHandler((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/v1/curator/")) return false;
        // Handle curator routes — fire-and-forget, the handler writes the response
        curatorHandler(req, res).catch((err) => {
          this.#logger.error("Curator route handler error", { error: String(err) });
        });
        return true;
      });

      // Register a curator-aware health endpoint on /health
      this.#gateway.addRouteHandler(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/health" && url.pathname !== "/") return false;
        // Return extended health with curator status summary
        const curatorStatus = await curator.status().catch(() => null);
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

      // Store the reference on the instance for external access
      (this as unknown as Record<string, unknown>)["#curator"] = curator;
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;

    this.#logger.info("Crew starting");
    await this.#extensionActivator.activateAll();

    await this.#channelProvider.connect();
    for (const provider of this.#additionalProviders) {
      await provider.connect();
    }

    try {
      const mcpConfig: ServerConfig = {
        name: "den-mcp",
        transport: this.#config.mcp.transport,
        endpoint: this.#config.mcp.endpoint,
        requestTimeout: this.#config.mcp.requestTimeout,
        maxReconnectAttempts: this.#config.mcp.maxReconnectAttempts,
        reconnectBaseDelay: this.#config.mcp.reconnectBaseDelay,
      };
      const tools = await this.#mcpClient.connect(mcpConfig);
      this.#mcpToolRegistry.setMcpTools(tools);
      await this.#mcpSurfaceManager.connectAll(loadProfiles(resolveCrewInstallLayout(this.#config).profilesRoot));
    } catch (error: unknown) {
      this.#logger.warn("MCP client connection failed (gateway continues)", {
        error: (error as Error).message,
      });
    }

    await syncConfiguredCronJobs(this.#cronRepository, this.#config.cron.jobs, new Date());
    await this.#gateway.start();
    await this.#cronScheduler?.start();
    await this.#adminServer?.start();
    if (this.#gatewayConfig.admin.bearerToken === null)
      this.#logger.warn("Admin diagnostics auth disabled", {
        host: this.#gatewayConfig.admin.host,
        port: this.#gatewayConfig.admin.port,
        allowLanBind: this.#gatewayConfig.admin.allowLanBind,
      });

    this.#started = true;
    this.#logger.info("Crew started");

    // Start service-work consumer AFTER channel provider is connected
    this.#serviceWorkConsumer.start();
  }

  async stop(reason: string): Promise<void> {
    if (!this.#started) {
      this.#runtimeDb.close();
      return;
    }

    this.#logger.info("Crew stopping", { reason });
    for (const unsubscribe of this.#backgroundReviewUnsubscribers) {
      unsubscribe();
    }
    await this.#extensionActivator.deactivateAll();

    this.#cronScheduler?.stop();
    (this as unknown as Record<string, unknown>)["#curator"]?.stopAutoScheduler();
    this.#serviceWorkConsumer.stop();
    this.#breadcrumbManager.dispose();
    this.#auditLogger.dispose();
    await this.#mcpClient.disconnect();
    await this.#mcpSurfaceManager.disconnectAll();
    await this.#channelProvider.disconnect();
    for (const provider of this.#additionalProviders) {
      await provider.disconnect();
    }
    await this.#adminServer?.stop();
    await this.#gateway.stop(reason);
    this.#runtimeDb.close();

    this.#started = false;
    this.#logger.info("Crew stopped");
  }

  get isRunning(): boolean {
    return this.#started;
  }

  #projectTools(sessionId: string | undefined): Promise<unknown> {
    const profilesRoot = resolveCrewInstallLayout(this.#config).profilesRoot;
    const agents = this.#config.fullAgents.filter((agent) =>
      sessionId === undefined ? agent.enabled : agent.session.sessionId === sessionId,
    );
    return Promise.resolve({ inventories: agents.map((agent) => resolveFullAgentRuntime({ agent, profilesRoot, mcpSurfaceManager: this.#mcpSurfaceManager, logger: this.#logger, defaultDenProjectId: this.#config.den.channelsProjectId }).inventory) });
  }

  get config(): CrewConfig { return this.#config; }
  get logger(): Logger { return this.#logger; } get eventBus(): EventBus { return this.#eventBus; }
  get gateway(): Gateway { return this.#gateway; } get runtimeDb(): RuntimeDb { return this.#runtimeDb; }
  get channelProvider(): ChannelProvider { return this.#channelProvider; } get mcpClient(): MCPClient { return this.#mcpClient; }
  get mcpToolRegistry(): McpToolRegistry { return this.#mcpToolRegistry; } get denCompletionPoster(): CompletionPoster { return this.#denCompletionPoster; }
  get sessionManager(): SessionManagerImpl { return this.#sessionManager; }
  get instancePool(): InstancePoolImpl { return this.#instancePool; }
  get breadcrumbManager(): BreadcrumbManager { return this.#breadcrumbManager; }
  get auditLogger(): AuditLogger { return this.#auditLogger; }
  get toolPolicyEnforcer(): ToolPolicyEnforcer { return this.#toolPolicyEnforcer; }
  get agentRegistry(): AgentRuntimeRegistry { return this.#agentRegistry; }
  get workerRuntimeHooks(): Pick<WorkerRuntimeConfig, "hookRegistry" | "toolPolicySessionRegistry"> {
    return { hookRegistry: this.#registry.hookRegistry, toolPolicySessionRegistry: this.#registry.toolPolicySessionRegistry };
  }

  get workerRoleMapping(): WorkerRoleMappingConfig { return this.#workerRoleMapping; }

  createAgentWorkerExecutor(): AgentWorkerExecutor {
    return createCrewAgentWorkerExecutor({
      mcpClient: this.#mcpClient,
      toolRegistry: this.#mcpToolRegistry,
      logger: this.#logger,
      profilesRoot: resolveCrewInstallLayout(this.#config).profilesRoot,
      delegatedSpawnLifecycle: this.#delegatedSpawnLifecycle,
      streamRetry: this.#config.streamRetry,
      eventBus: this.#eventBus,
      memory: this.#config.memory,
    });
  }

  createDenAssignmentRunner(member: DenPoolMemberConfig | undefined): DenAssignmentRunner {
    if (member === undefined) throw new ConfigurationError("Crew requires a configured workerPool member to create a Den assignment runner");
    const workerRuntime = new WorkerRuntime(
      { workerIdentity: member.workerIdentity, ...this.workerRuntimeHooks, agentRuntimeRegistry: this.#agentRegistry },
      this.#workerRoleMapping,
      this.#sessionManager,
      this.#instancePool,
      this.#eventBus,
      this.#logger,
      this.#auditRepository,
      this.#denCompletionPoster,
    );
    return createDenAssignmentRunner({
      assignmentConsumer: createDenPoolAssignmentConsumer({ mcpClient: this.#mcpClient, member }),
      workerRuntime,
      executorFactory: () => this.createAgentWorkerExecutor(),
      mcpClient: this.#mcpClient,
      workerIdentity: member.workerIdentity,
    });
  }

  /**
   * Runtime crew config reload handler.
   *
   * Validates the candidate config, computes diffs against the current
   * CrewConfig, and applies safe changes at runtime. Changes to
   * infrastructure keys (den.*, database.*, etc.) are blocked.
   *
   * Currently supports:
   * - fullAgents additions: registers new session configs
   * - fullAgents removals: logged with drain reminder
   * - workerPool changes: logged (runtime pool updates deferred)
   *
   * Returns an ExtensionConfigReloadOutcome-compatible shape so the
   * existing RemediationControlService can consume it.
   */
  async #crewReloadConfig(candidateConfig: unknown): Promise<ExtensionConfigReloadOutcome> {
    const newConfig = CrewConfigSchema.safeParse(candidateConfig);
    if (!newConfig.success) {
      const issues = newConfig.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new ConfigurationError(`Invalid crew config: ${issues}`);
    }

    const oldConfig = this.#config;
    const changedKeys: string[] = [];
    const affectedExtensionIds: string[] = [];
    const nonReloadableKeys: string[] = [];
    const warnings: string[] = [];

    // ── Detect non-reloadable changes ──────────────────────────
    const nonReloadablePaths = ["den", "database", "install", "runtime", "profiles"];
    for (const path of nonReloadablePaths) {
      const oldVal = JSON.stringify(getNested(oldConfig, path));
      const newVal = JSON.stringify(getNested(newConfig.data, path));
      if (oldVal !== newVal) {
        nonReloadableKeys.push(path);
      }
    }

    if (nonReloadableKeys.length > 0) {
      this.#logger.warn("config.reload.blocked", {
        nonReloadableKeys,
        detail: "These keys require a restart to change",
      });
      return {
        changedKeys: nonReloadableKeys,
        affectedExtensionIds: [],
        nonReloadableKeys,
        reactivatedExtensionIds: [],
        skippedExtensionIds: ["crew-config"],
        status: "blocked",
        warnings: ["Non-reloadable config keys changed; restart required"],
      };
    }

    // ── fullAgents diff ────────────────────────────────────────
    const oldAgentIds = new Set(oldConfig.fullAgents.filter((a) => a.enabled).map((a) => a.agentId));
    const newAgentIds = new Set(newConfig.data.fullAgents.filter((a) => a.enabled).map((a) => a.agentId));

    const addedAgents = newConfig.data.fullAgents.filter((a) => a.enabled && !oldAgentIds.has(a.agentId));
    const removedAgents = oldConfig.fullAgents.filter((a) => a.enabled && !newAgentIds.has(a.agentId));

    if (addedAgents.length > 0 || removedAgents.length > 0) {
      changedKeys.push("fullAgents");
      affectedExtensionIds.push("crew-config");

      if (addedAgents.length > 0) {
        this.#logger.info("config.reload.agents_added", {
          agents: addedAgents.map((a) => a.agentId),
        });

        // Register new agent session configs
        const oldFullAgents = [...oldConfig.fullAgents];
        const mergedAgents = [...oldFullAgents, ...addedAgents];
        const mergedConfig = { ...oldConfig, fullAgents: mergedAgents };
        configureFullSessionManager(this.#sessionManager, mergedConfig);
      }

      if (removedAgents.length > 0) {
        warnings.push(
          `Agents ${removedAgents.map((a) => a.agentId).join(", ")} were removed from config. ` +
          "They will not receive new events. Active conversations should be drained naturally. " +
          "Forced session archive requires admin API.",
        );
        this.#logger.warn("config.reload.agents_removed", {
          agents: removedAgents.map((a) => a.agentId),
        });
      }
    }

    // ── workerPool diff ────────────────────────────────────────
    const oldPoolJson = JSON.stringify(oldConfig.workerPool);
    const newPoolJson = JSON.stringify(newConfig.data.workerPool);
    if (oldPoolJson !== newPoolJson) {
      changedKeys.push("workerPool");
      affectedExtensionIds.push("crew-config");
      warnings.push("Worker pool changes detected. Runtime pool reconfiguration requires a restart.");
      this.#logger.info("config.reload.worker_pool_changed", {
        detail: "Runtime pool reconfiguration deferred",
      });
    }

    // ── Apply safe config changes ──────────────────────────────
    if (changedKeys.length > 0) {
      // Update the internal config reference
      (this as unknown as Record<string, unknown>)["#config"] = newConfig.data;
      this.#logger.info("config.reload.applied", { changedKeys, warnings });
    }

    const allKeys = [...new Set([...nonReloadableKeys, ...changedKeys])];
    const status = changedKeys.length > 0 ? "reloaded" as const : "unchanged" as const;

    return {
      changedKeys: allKeys,
      affectedExtensionIds: [...new Set(affectedExtensionIds)],
      nonReloadableKeys,
      reactivatedExtensionIds: changedKeys.length > 0 ? ["crew-config"] : [],
      skippedExtensionIds: changedKeys.length > 0 ? [] : ["crew-config"],
      status,
      warnings,
    };
  }

  /**
   * Handle a turn.completed event for background review lifecycle.
   *
   * 1. Increment the turn counter.
   * 2. Check if any review trigger threshold has been reached.
   * 3. If triggered, post a structured trigger message to the service-work channel.
   * 4. On any failure, log at warning level and silently drop — counter is NOT reset here.
   *
   * The caretaker owns counter reset at review START, not the hook.
   */
  #handleTurnCompleted(
    payload: { readonly sessionId: string; readonly profileId: string | undefined; readonly turnNumber: number; readonly durationMs: number },
    config: CrewConfig,
  ): void {
    const profileId = payload.profileId;
    if (profileId === undefined) return;

    // Step 1: increment turn counter (fire-and-forget, never throws)
    void this.#counterService.incrementTurn(profileId, payload.sessionId).catch((error: unknown) => {
      this.#logger.warn("Background review turn increment failed", {
        profileId,
        sessionId: payload.sessionId,
        error: String(error),
      });
    });

    // Step 2: resolve profile-level overrides. Load the profile to check
    // for per-profile backgroundReview config; fall back to service-level defaults.
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
      // Profile not found — continue with service-level defaults
    }

    // Profile-level enabled=false overrides the service-level enabled gate
    if (enabledOverride === false) return;

    // Step 3: check trigger thresholds
    void this.#counterService
      .checkTrigger(profileId, payload.sessionId, {
        memoryNudgeInterval,
        skillNudgeInterval,
      })
      .then((trigger) => {
        if (trigger === null) return;

        // Step 3: post trigger message to service-work channel
        const triggerMessage = JSON.stringify({
          type: "background_review_trigger",
          profileId,
          sessionId: payload.sessionId,
          triggerType: trigger.type,
          turnsSinceMemory: trigger.turnsSinceMemory,
          itersSinceSkill: trigger.itersSinceSkill,
        });

        void this.#channelProvider
          .sendMessage(config.backgroundReview.serviceWorkChannel, {
            kind: "text",
            text: triggerMessage,
          })
          .then(() => {
            this.#logger.info("Background review trigger posted", {
              profileId,
              sessionId: payload.sessionId,
              triggerType: trigger.type,
              channelId: config.backgroundReview.serviceWorkChannel,
            });
          })
          .catch((error: unknown) => {
            // Step 4: failure — silently drop, counter NOT reset
            this.#logger.warn("Background review trigger post failed", {
              profileId,
              sessionId: payload.sessionId,
              triggerType: trigger.type,
              channelId: config.backgroundReview.serviceWorkChannel,
              error: String(error),
            });
          });
      })
      .catch((error: unknown) => {
        this.#logger.warn("Background review checkTrigger failed", {
          profileId,
          sessionId: payload.sessionId,
          error: String(error),
        });
      });
  }

  /**
   * Handle a background review trigger claimed by the ServiceWorkConsumer.
   * Resets counters to prevent re-triggering and logs the lifecycle event.
   */
  #handleTriggerClaimed(
    payload: {
      readonly profileId: string;
      readonly sessionId: string;
      readonly triggerType: string;
      readonly reviewId: string;
    },
  ): void {
    void this.#counterService
      .resetCounter(payload.profileId, payload.sessionId, payload.triggerType as "memory" | "skill" | "combined")
      .then(() => {
        this.#logger.info("Background review counter reset after trigger claim", {
          reviewId: payload.reviewId,
          profileId: payload.profileId,
          sessionId: payload.sessionId,
          triggerType: payload.triggerType,
        });

        // Spawn the background review analysis
        void this.#backgroundReviewRunner.runReview({
          profileId: payload.profileId,
          sessionId: payload.sessionId,
          triggerType: payload.triggerType as "memory" | "skill" | "combined",
          reviewId: payload.reviewId,
        }).catch((error: unknown) => {
          this.#logger.error("Background review runner error", {
            reviewId: payload.reviewId,
            error: String(error),
          });
        });
      })
      .catch((error: unknown) => {
        this.#logger.warn("Background review counter reset failed", {
          reviewId: payload.reviewId,
          profileId: payload.profileId,
          sessionId: payload.sessionId,
          error: String(error),
        });
      });
  }
}

export function bootstrap(yamlPath: string): Crew {
  return new Crew(loadCrewConfig(yamlPath));
}

/**
 * Safely traverse a dot-separated path into a nested object.
 * Returns undefined for missing paths instead of throwing.
 */
function getNested(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
