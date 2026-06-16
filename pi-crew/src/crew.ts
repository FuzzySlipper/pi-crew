import type { Logger, EventBus, ChannelProvider, AgentWorkBreadcrumbRepository } from "@pi-crew/core";
import { ConfigurationError, FakeEventBus, FakeLogger, InMemoryHookRegistry } from "@pi-crew/core";
import { DenChannelsAdapter } from "@pi-crew/channels/den-channels/den-channels-adapter";
import type { DenChannelsAdapterConfig } from "@pi-crew/channels/den-channels/den-channels-adapter";
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
  type GatewayConfig,
  type ServiceRegistry,
  type WorkerRoleMappingConfig,
  type WorkerRuntimeConfig,
  type AgentWorkerExecutor,
  CronScheduler,
  SqliteCronJobRepository,
  ScriptCronJobExecutor,
  type CronJobRepository,
} from "@pi-crew/service";
import { loadCrewConfig, CrewConfigSchema, resolveCrewInstallLayout, type CrewConfig } from "./config.js";
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
import { DefaultMcpSurfaceManager, type McpSurfaceManager } from "./mcp-surface-manager.js";
import { SteerFollowUpBridge } from "./steer-followup-bridge.js";
import { createCrewAgentWorkerExecutor } from "./agent-worker-executor-factory.js";
import {
  createDeferredDelegationLifecyclePort,
  createDelegatedChildRunner,
} from "./delegation-composition.js";
import {
  configureFullSessionManager,
  configuredFullAgentMemberIdentities,
  configuredFullAgentAdditionalProjectIds,
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
  #started = false;
  constructor(config: CrewConfig, logger?: Logger, eventBus?: EventBus) {
    this.#config = config;
    loadProfile(config.sessions.fallbackProfileId, resolveCrewInstallLayout(config).profilesRoot);
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
    this.#auditRepository = new SqliteAuditRepository(this.#runtimeDb.handle);
    const sqliteAgentWorkBreadcrumbRepository = new SqliteAgentWorkBreadcrumbRepository(this.#runtimeDb.handle);
    this.#agentWorkBreadcrumbRepository = new PublishingAgentWorkBreadcrumbRepository({
      inner: sqliteAgentWorkBreadcrumbRepository,
      publisher: new HttpAgentWorkLifecyclePublisher({
        baseUrl: config.den.channelsUrl, token: config.den.channelsToken, logger: this.#logger,
      }),
      logger: this.#logger,
    });
    const diagnostics = createCrewDiagnostics({
      eventBus: this.#eventBus,
      runtimeDb: this.#runtimeDb,
      sessionStore,
    });
    const cursorStore = createSqliteCursorStore(this.#runtimeDb);
    const denConnection = buildDenConnection(
      config.den,
      this.#logger,
      cursorStore,
      configuredFullAgentMemberIdentities(config),
      configuredFullAgentAdditionalProjectIds(config, config.den.channelsProjectId),
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
    this.#denCompletionPoster = createDenCompletionPoster({
      mcpClient: this.#mcpClient,
      projectId: "pi-crew",
      requestedBy: "pi-crew",
      logger: this.#logger,
      completionDefaults: completionDefaultsFromEnv(process.env),
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
    configureFullSessionManager(this.#sessionManager, config);
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
              projectId: "pi-crew",
              sender: "pi-crew",
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
          parentAgentIdentity: "pi-crew",
        }),
        new ParentLifecycleBreadcrumbExtension({
          repository: this.#agentWorkBreadcrumbRepository,
          logger: this.#logger,
          bindings: config.fullAgents.filter((agent) => agent.enabled).map((agent) => ({
            sessionId: agent.session.sessionId, channelId: agent.channels[0]?.channelId ?? config.den.channelsSubscriptionChannelId,
            projectId: agent.channels[0]?.projectId ?? config.den.channelsProjectId, agentIdentity: agent.memberIdentity, profileId: agent.profileId,
            provider: agent.runtime.provider, model: agent.runtime.model,
          })),
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
      return this.#sessionManager.routeMessage(this.#channelProvider, message);
    });

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

    this.#logger.info("Crew composition root assembled", {
      config: {
        denCoreUrl: config.den.coreUrl,
        mcpEndpoint: config.mcp.endpoint,
        dbPath: config.database.path,
        sessions: config.sessions,
      },
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;

    this.#logger.info("Crew starting");
    await this.#extensionActivator.activateAll();

    await this.#channelProvider.connect();

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
  }

  async stop(reason: string): Promise<void> {
    if (!this.#started) {
      this.#runtimeDb.close();
      return;
    }

    this.#logger.info("Crew stopping", { reason });
    await this.#extensionActivator.deactivateAll();

    this.#cronScheduler?.stop();
    this.#breadcrumbManager.dispose();
    this.#auditLogger.dispose();
    await this.#mcpClient.disconnect();
    await this.#mcpSurfaceManager.disconnectAll();
    await this.#channelProvider.disconnect();
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
