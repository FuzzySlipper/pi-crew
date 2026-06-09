/** pi-crew composition root — wires all modules into a running gateway. */

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
  RemediationControlService,
  ExtensionActivator,
  createServiceExtensionContext,
  InMemoryToolPolicySessionRegistry,
  ToolPolicyExtension,
  AgentRuntimeRegistry,
  DelegatedSpawnLifecycle,
  DelegatedOrphanCleanup,
  WorkerRuntime,
  SessionManagerDelegationSessionBridge,
  SessionMaterializedDelegatedChildRunner,
  SqliteAuditRepository,
  SqliteSessionRepository,
  type GatewayConfig,
  type ServiceRegistry,
  type WorkerRoleMappingConfig,
  type WorkerRuntimeConfig,
  type AgentWorkerExecutor,
} from "@pi-crew/service";

import { loadCrewConfig, type CrewConfig } from "./config.js";
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
  auditEntryToRecord,
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

    // DESIGN: Validate configured profile IDs before runtime routing.
    // Rationale: SessionManager receives policy, not global fallback magic.
    loadProfile(config.sessions.fallbackProfileId, config.profiles.root);

    // DESIGN: Worker role mapping is config-parse validated and injected.
    // Rationale: avoid hardcoded role-to-profile switches in WorkerRuntime.
    this.#workerRoleMapping = config.workers;

    // 1. Infrastructure
    this.#logger = logger ?? new FakeLogger();
    this.#eventBus = eventBus ?? new FakeEventBus();
    const hookRegistry = new InMemoryHookRegistry(this.#logger);
    const toolPolicySessions = new InMemoryToolPolicySessionRegistry();

    // Build the GatewayConfig subset for pi-service
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

    // 1b. Local runtime persistence (#1866). Den remains workflow
    // source-of-truth; this DB stores hot sessions/audit/cache locally.
    this.#runtimeDb = new RuntimeDb(config.database, this.#logger);
    const sessionStore = new SqliteSessionRepository(this.#runtimeDb.handle, this.#logger);
    this.#auditRepository = new SqliteAuditRepository(this.#runtimeDb.handle);
    const diagnostics = createCrewDiagnostics({
      eventBus: this.#eventBus,
      runtimeDb: this.#runtimeDb,
      sessionStore,
    });

    // 2. Channel provider (Den Channels adapter).
    const cursorStore = createSqliteCursorStore(this.#runtimeDb);
    const denConnection = buildDenConnection(config.den, this.#logger, cursorStore);
    this.#channelProvider = new DenChannelsAdapter(denConnection, this.#logger, {
      name: "Den Channels Gateway",
    } satisfies DenChannelsAdapterConfig);

    // 3. MCP client + tool registry
    this.#mcpClient = new MCPClient(this.#logger, this.#eventBus);
    this.#mcpToolRegistry = new McpToolRegistry(this.#logger);

    // 3b. Den completion poster — posts structured completion packets
    //     to Den Core via the MCP client (canonical post_worker_completion_packet).
    this.#denCompletionPoster = createDenCompletionPoster({
      mcpClient: this.#mcpClient,
      projectId: "pi-crew",
      requestedBy: "pi-crew",
      logger: this.#logger,
    });

    // 3c. Agent runtime registry and steer/followUp bridge
    //     Routes mid-assignment interaction from Den Channels direct-agent
    //     events with intent=steer or intent=follow_up to the correct
    //     active supervised Agent.
    this.#agentRegistry = new AgentRuntimeRegistry();
    this.#steerFollowUpBridge = new SteerFollowUpBridge(this.#agentRegistry, this.#logger);

    // 4. Instance pool + factory
    const responderFactory = buildRuntimeResponderFactory(config.runtime, this.#eventBus);
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

    this.#adminServer = config.admin.enabled
      ? new AdminServer({
          config: this.#gatewayConfig.admin,
          diagnostics,
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

    // 5. SQLite session store + agent factory + session manager
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

    const delegationBridge = new SessionManagerDelegationSessionBridge({
      sessionManager: this.#sessionManager,
      sessionStore,
      eventBus: this.#eventBus,
      logger: this.#logger,
    });
    this.#delegatedSpawnLifecycle = new DelegatedSpawnLifecycle({
      hookRegistry: this.#registry.hookRegistry,
      delegationSessions: delegationBridge,
      eventBus: this.#eventBus,
      logger: this.#logger,
      childRunner: new SessionMaterializedDelegatedChildRunner(),
    });
    new DelegatedOrphanCleanup({
      delegationSessions: delegationBridge,
      eventBus: this.#eventBus,
      logger: this.#logger,
    }).activate();
    this.#extensionActivator = new ExtensionActivator({
      extensions: [new ToolPolicyExtension(this.#registry.toolPolicySessionRegistry)],
      context: createServiceExtensionContext({
        config: this.#registry.config,
        logger: this.#registry.logger,
        eventBus: this.#registry.eventBus,
        hookRegistry: this.#registry.hookRegistry,
        delegationSessions: delegationBridge,
      }),
    });

    new SessionPresenceBridge(this.#eventBus, this.#channelProvider, this.#logger);

    // 6. Wire channel provider → steer/followUp bridge → session manager routing
    //    Steer/followUp events with intent metadata are intercepted by the
    //    bridge before falling through to normal session routing.
    this.#channelProvider.onMessage((message) => {
      if (this.#steerFollowUpBridge.route(message)) return Promise.resolve();
      return this.#sessionManager.routeMessage(this.#channelProvider, message);
    });

    // 7. Governance: breadcrumbs + audit log
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

    // 8. Tool policy enforcer (runtime tool filtering)
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

  // ── Lifecycle ───────────────────────────────────────────────

  /** Start the gateway and connect all providers. */
  async start(): Promise<void> {
    if (this.#started) return;

    this.#logger.info("Crew starting");
    await this.#extensionActivator.activateAll();

    await this.#channelProvider.connect();

    // Connect MCP client and discover tools
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
      // MCP connection is best-effort at startup; gateway still starts
      this.#logger.warn("MCP client connection failed (gateway continues)", {
        error: (error as Error).message,
      });
    }

    await this.#gateway.start();
    await this.#adminServer?.start();

    this.#started = true;
    this.#logger.info("Crew started");
  }

  /** Graceful shutdown. */
  async stop(reason: string): Promise<void> {
    if (!this.#started) {
      this.#runtimeDb.close();
      return;
    }

    this.#logger.info("Crew stopping", { reason });
    await this.#extensionActivator.deactivateAll();

    // Dispose governance
    this.#breadcrumbManager.dispose();
    this.#auditLogger.dispose();

    // Disconnect MCP client
    await this.#mcpClient.disconnect();

    // Disconnect channel provider
    await this.#channelProvider.disconnect();

    // Stop gateway
    await this.#adminServer?.stop();
    await this.#gateway.stop(reason);

    // Close local runtime DB/cache after subscribers have flushed.
    this.#runtimeDb.close();

    this.#started = false;
    this.#logger.info("Crew stopped");
  }

  // ── Accessors (for testing and inspection) ─────────────────

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

  /** Validated worker role mapping for injecting into WorkerRuntime. */
  get workerRoleMapping(): WorkerRoleMappingConfig {
    return this.#workerRoleMapping;
  }

  /** Build the production LLM-backed worker executor with live MCP tools. */
  createAgentWorkerExecutor(): AgentWorkerExecutor {
    return createCrewAgentWorkerExecutor({
      mcpClient: this.#mcpClient,
      toolRegistry: this.#mcpToolRegistry,
      logger: this.#logger,
      profilesRoot: this.#config.profiles.root,
      delegatedSpawnLifecycle: this.#delegatedSpawnLifecycle,
    });
  }

  /** Build the production Den assignment runner for one concrete pool member. */
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

// ── Convenience: bootstrap from YAML path ───────────────────────
export function bootstrap(yamlPath: string): Crew {
  const config = loadCrewConfig(yamlPath);
  return new Crew(config);
}
