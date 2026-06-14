import type { Logger, EventBus, ChannelProvider } from "@pi-crew/core";
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
  DirectDebugSessionService,
  ConversationalSessionResetService,
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
  SqliteSessionRepository,
  SqliteMessageRepository,
  MessageRepositoryTurnHistory,
  type GatewayConfig,
  type ServiceRegistry,
  type WorkerRoleMappingConfig,
  type WorkerRuntimeConfig,
  type AgentWorkerExecutor,
} from "@pi-crew/service";
import { loadCrewConfig, resolveCrewInstallLayout, type CrewConfig } from "./config.js";
export {
  CrewConfigSchema,
  loadCrewConfig,
  resolveCrewConfigPath,
  resolveCrewInstallLayout,
  type CrewConfig,
} from "./config.js";
import { MCPClient, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import type { ServerConfig } from "@pi-crew/mcp";
import { BreadcrumbManager, AuditLogger } from "@pi-crew/governance";
import { ToolPolicyEnforcer } from "@pi-crew/tools";
import { loadProfile } from "@pi-crew/profiles";
import { buildDenConnection, createSqliteCursorStore } from "./den-connection-factory.js";
import { buildRuntimeResponderFactory } from "./runtime-responder-factory.js";
import { SessionKindAwareResponderFactory } from "./session-kind-responder-factory.js";
import { createDenCompletionPoster } from "./den-completion-poster.js";
import { createDenAssignmentRunner } from "./den-assignment-runner.js";
import { createDenPoolAssignmentConsumer } from "./den-pool-source.js";
import type { DenAssignmentRunner } from "./den-assignment-runner.js";
import type { DenPoolMemberConfig } from "./den-pool-source.js";
import { createCrewDiagnostics } from "./crew-diagnostics.js";
import { createDenAdminEvidencePoster } from "./den-admin-evidence-poster.js";
import { SteerFollowUpBridge } from "./steer-followup-bridge.js";
import { createCrewAgentWorkerExecutor } from "./agent-worker-executor-factory.js";
import {
  createDeferredDelegationLifecyclePort,
  createDelegatedChildRunner,
} from "./delegation-composition.js";
import {
  configureConversationalSessionManager,
  configuredConversationalMemberIdentities,
} from "./conversational-agent-sessions.js";
import {
  auditEntryToRecord,
  completionDefaultsFromEnv,
  createFallbackChannelBinding,
  validateGatewayConfig,
} from "./crew-helpers.js";
import type { CompletionPoster } from "@pi-crew/tools";
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
  readonly #workerRoleMapping: WorkerRoleMappingConfig;
  readonly #channelProvider: ChannelProvider;
  readonly #mcpClient: MCPClient;
  readonly #mcpToolRegistry: McpToolRegistry;
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
      configuredConversationalMemberIdentities(config),
    );
    this.#channelProvider = new DenChannelsAdapter(denConnection, this.#logger, {
      name: "Den Channels Gateway",
    } satisfies DenChannelsAdapterConfig);

    this.#mcpClient = new MCPClient(this.#logger, this.#eventBus);
    this.#mcpToolRegistry = new McpToolRegistry(this.#logger);

    this.#denCompletionPoster = createDenCompletionPoster({
      mcpClient: this.#mcpClient,
      projectId: "pi-crew",
      requestedBy: "pi-crew",
      logger: this.#logger,
      completionDefaults: completionDefaultsFromEnv(process.env),
    });

    this.#agentRegistry = new AgentRuntimeRegistry();
    this.#steerFollowUpBridge = new SteerFollowUpBridge(this.#agentRegistry, this.#logger);

    const conversationalDelegationLifecycle = createDeferredDelegationLifecyclePort();
    const messageRepository = new SqliteMessageRepository(this.#runtimeDb.handle);
    const conversationalFactory = buildRuntimeResponderFactory(
      config,
      this.#eventBus,
      this.#logger,
      this.#mcpToolRegistry,
      this.#mcpClient,
      new MessageRepositoryTurnHistory(messageRepository),
      { lifecycle: conversationalDelegationLifecycle.port },
      {
        baseUrl: config.den.channelsUrl,
        token: config.den.channelsToken,
      },
    );
    const responderFactory = new SessionKindAwareResponderFactory(conversationalFactory);
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
    configureConversationalSessionManager(this.#sessionManager, config);

    const sessionResetService = new ConversationalSessionResetService({
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
          }),
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
          }),
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
      }),
      childRegistry,
    });
    conversationalDelegationLifecycle.set(this.#delegatedSpawnLifecycle);
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
    } catch (error: unknown) {
      this.#logger.warn("MCP client connection failed (gateway continues)", {
        error: (error as Error).message,
      });
    }

    await this.#gateway.start();
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

    this.#breadcrumbManager.dispose();
    this.#auditLogger.dispose();
    await this.#mcpClient.disconnect();
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
  get config(): CrewConfig {
    return this.#config;
  }
  get logger(): Logger {
    return this.#logger;
  }
  get eventBus(): EventBus {
    return this.#eventBus;
  }
  get gateway(): Gateway {
    return this.#gateway;
  }
  get runtimeDb(): RuntimeDb {
    return this.#runtimeDb;
  }
  get channelProvider(): ChannelProvider {
    return this.#channelProvider;
  }
  get mcpClient(): MCPClient {
    return this.#mcpClient;
  }
  get mcpToolRegistry(): McpToolRegistry {
    return this.#mcpToolRegistry;
  }
  get denCompletionPoster(): CompletionPoster {
    return this.#denCompletionPoster;
  }
  get sessionManager(): SessionManagerImpl {
    return this.#sessionManager;
  }
  get instancePool(): InstancePoolImpl {
    return this.#instancePool;
  }
  get breadcrumbManager(): BreadcrumbManager {
    return this.#breadcrumbManager;
  }
  get auditLogger(): AuditLogger {
    return this.#auditLogger;
  }
  get toolPolicyEnforcer(): ToolPolicyEnforcer {
    return this.#toolPolicyEnforcer;
  }
  get agentRegistry(): AgentRuntimeRegistry {
    return this.#agentRegistry;
  }
  get workerRuntimeHooks(): Pick<
    WorkerRuntimeConfig,
    "hookRegistry" | "toolPolicySessionRegistry"
  > {
    return {
      hookRegistry: this.#registry.hookRegistry,
      toolPolicySessionRegistry: this.#registry.toolPolicySessionRegistry,
    };
  }

  get workerRoleMapping(): WorkerRoleMappingConfig {
    return this.#workerRoleMapping;
  }

  createAgentWorkerExecutor(): AgentWorkerExecutor {
    return createCrewAgentWorkerExecutor({
      mcpClient: this.#mcpClient,
      toolRegistry: this.#mcpToolRegistry,
      logger: this.#logger,
      profilesRoot: resolveCrewInstallLayout(this.#config).profilesRoot,
      delegatedSpawnLifecycle: this.#delegatedSpawnLifecycle,
    });
  }

  createDenAssignmentRunner(member: DenPoolMemberConfig | undefined): DenAssignmentRunner {
    if (member === undefined) {
      throw new ConfigurationError(
        "Crew requires a configured workerPool member to create a Den assignment runner",
      );
    }
    const workerRuntime = new WorkerRuntime(
      {
        workerIdentity: member.workerIdentity,
        ...this.workerRuntimeHooks,
        agentRuntimeRegistry: this.#agentRegistry,
      },
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
}

export function bootstrap(yamlPath: string): Crew {
  const config = loadCrewConfig(yamlPath);
  return new Crew(config);
}
