/**
 * pi-crew composition root — wires all modules into a running gateway.
 *
 * The only file that instantiates concrete adapters (DenChannelsAdapter),
 * persistence backends (RuntimeDb), and platform connections. Every other
 * module depends on interfaces (ChannelProvider, EventBus, Logger) defined
 * in pi-core.
 *
 * @module pi-crew/crew
 */

import type { Logger, EventBus, ChannelProvider } from "@pi-crew/core";
import { FakeLogger, FakeEventBus } from "@pi-crew/core";

import { DenChannelsAdapter } from "@pi-crew/channels/den-channels/den-channels-adapter";
import type { DenChannelsAdapterConfig } from "@pi-crew/channels/den-channels/den-channels-adapter";

import {
  loadConfig,
  Gateway,
  createServiceRegistry,
  SessionManagerImpl,
  AgentFactoryImpl,
  InstancePoolImpl,
  InstanceFactoryImpl,
  RuntimeDb,
  AdminServer,
  RemediationControlService,
  SqliteAuditRepository,
  SqliteSessionRepository,
  type GatewayConfig,
  type ServiceRegistry,
  type WorkerRoleMappingConfig,
} from "@pi-crew/service";

import { loadCrewConfig, type CrewConfig } from "./config.js";
export { CrewConfigSchema, loadCrewConfig, type CrewConfig } from "./config.js";

import { MCPClient, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import type { ServerConfig } from "@pi-crew/mcp";

import { BreadcrumbManager, AuditLogger } from "@pi-crew/governance";
import type { AuditEntry } from "@pi-crew/governance";

import { ToolPolicyEnforcer } from "@pi-crew/tools";
import { loadProfile } from "@pi-crew/profiles";

import { buildDenConnection, createSqliteCursorStore } from "./den-connection-factory.js";
import { buildRuntimeResponderFactory } from "./runtime-responder-factory.js";
import { createDenCompletionPoster } from "./den-completion-poster.js";
import { createCrewDiagnostics } from "./crew-diagnostics.js";
import { createDenAdminEvidencePoster } from "./den-admin-evidence-poster.js";
import type { CompletionPoster } from "@pi-crew/tools";

// ── Crew ───────────────────────────────────────────────────────

/**
 * Top-level composition that wires all pi-crew modules together.
 *
 * Owns concrete instantiation of adapters, persistence, and platform
 * connections. Every other module is injected with interfaces.
 */
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

  readonly #instancePool: InstancePoolImpl;

  #started = false;

  constructor(config: CrewConfig, logger?: Logger, eventBus?: EventBus) {
    this.#config = config;

    // DESIGN: The composition root validates configured profile IDs before
    // runtime routing. Rationale: SessionManager should receive policy, not
    // own global profile loading or magic fallback identifiers.
    loadProfile(config.sessions.fallbackProfileId);

    // DESIGN: The worker role mapping is validated at config-parse time
    // (duplicate roles rejected, at least one binding required, every
    // role + profileId must be non-empty). Store it so callers can
    // inject it into WorkerRuntime instead of relying on a hardcoded
    // role-to-profile switch.
    this.#workerRoleMapping = config.workers;

    // 1. Infrastructure
    this.#logger = logger ?? new FakeLogger();
    this.#eventBus = eventBus ?? new FakeEventBus();

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

    // 2. Channel provider (Den Channels adapter)
    //
    // Production path: when den.channelsUrl is a non-empty URL, the
    // protocol determines the adapter:
    //   ws:// / wss:// → DenWebSocketConnection (legacy WebSocket)
    //   http:// / https:// → DenHttpDirectAgentConnection (HTTP cursor)
    // Test/offline path: when channelsUrl is empty, fall back to
    // SimulatedDenConnection for tests and development.
    //
    // HTTP mode fails closed when projectId or memberIdentity are
    // missing — no silent fallback to simulated.  Cursor persistence
    // uses the runtime_kv table via a SQLite-backed CursorStore.
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
    );

    // 6. Wire channel provider → session manager routing
    this.#channelProvider.onMessage((message) => {
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

    // Connect the channel provider
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

    // Start the gateway (health check, etc.)
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

  /**
   * The validated worker role mapping for injecting into WorkerRuntime.
   *
   * Replaces the v1 hardcoded role-to-profile switch. Validated at
   * config-parse time (no duplicate roles, at least one binding).
   */
  get workerRoleMapping(): WorkerRoleMappingConfig {
    return this.#workerRoleMapping;
  }
}

function auditEntryToRecord(entry: AuditEntry): Record<string, unknown> {
  return {
    timestamp: entry.timestamp,
    event: entry.event,
    payload: entry.payload,
    correlation: entry.correlation,
  };
}

function validateGatewayConfig(raw: unknown) {
  try {
    loadConfig(raw);
    return { valid: true, errors: [] };
  } catch (error: unknown) {
    return { valid: false, errors: [(error as Error).message] };
  }
}

// ── Convenience: bootstrap from YAML path ───────────────────────

/**
 * Bootstrap the gateway from a YAML configuration file.
 *
 * This is the primary entry point for production use. For integration
 * testing, construct {@link Crew} directly with a {@link CrewConfig}.
 */
export function bootstrap(yamlPath: string): Crew {
  const config = loadCrewConfig(yamlPath);
  return new Crew(config);
}
