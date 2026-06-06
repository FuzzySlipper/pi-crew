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

import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";

import { z } from "zod";

import type {
  Logger,
  EventBus,
  ChannelProvider,
} from "@pi-crew/core";
import { ConfigurationError, FakeLogger, FakeEventBus } from "@pi-crew/core";

import {
  DenChannelsAdapter,
  DenWebSocketConnection,
  DenHttpDirectAgentConnection,
  SimulatedDenConnection,
  type DenChannelsAdapterConfig,
  type DenConnectionConfig,
  type DenHttpConnectionConfig,
  type CursorStore,
  type DenConnection,
} from "@pi-crew/channels";

import {
  loadConfig,
  GatewayConfigSchema,
  Gateway,
  createServiceRegistry,
  SessionManagerImpl,
  AgentFactoryImpl,
  InstancePoolImpl,
  InstanceFactoryImpl,
  RuntimeDb,
  SqliteAuditRepository,
  SqliteSessionRepository,
  type GatewayConfig,
  type DenConfig,
  type ServiceRegistry,
} from "@pi-crew/service";

import { MCPClient, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import type { ServerConfig } from "@pi-crew/mcp";

import { BreadcrumbManager, AuditLogger } from "@pi-crew/governance";
import type { AuditEntry } from "@pi-crew/governance";

import { ToolPolicyEnforcer } from "@pi-crew/tools";
import { loadProfile } from "@pi-crew/profiles";

// ── Crew-level config schema ───────────────────────────────────

const McpConfigSchema = z.object({
  transport: z.enum(["stdio", "streamable-http"]).default("streamable-http"),
  endpoint: z.string().default("http://den-k8plus:3100/mcp"),
  requestTimeout: z.number().int().positive().default(30_000),
  maxReconnectAttempts: z.number().int().positive().default(3),
  reconnectBaseDelay: z.number().int().positive().default(1_000),
});

const SessionsConfigSchema = z.object({
  maxTotal: z.number().int().positive().default(16),
  maxPerProfile: z.number().int().positive().default(4),
  idleTimeoutMs: z.number().int().positive().default(28_800_000),
  fallbackProfileId: z.string().min(1).default("system-architect"),
});

const ToolPolicyDefaultsSchema = z.object({
  allowedTools: z.array(z.string()).default([]),
  deniedTools: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  deniedHosts: z.array(z.string()).default([]),
});

export const CrewConfigSchema = z.object({
  den: GatewayConfigSchema.shape.den,
  database: GatewayConfigSchema.shape.database.default({}),
  health: GatewayConfigSchema.shape.health.default({}),
  logging: GatewayConfigSchema.shape.logging.default({}),
  mcp: McpConfigSchema.default({}),
  sessions: SessionsConfigSchema.default({}),
  toolPolicy: ToolPolicyDefaultsSchema.default({}),
});

export type CrewConfig = z.infer<typeof CrewConfigSchema>;

// ── CrewConfig default loader ──────────────────────────────────

/**
 * Load crew-level configuration from a YAML file path.
 *
 * Validates the shape and falls back to sensible defaults for every
 * field except `den.coreUrl`, which must be provided.
 */
export function loadCrewConfig(yamlPath: string): CrewConfig {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed: unknown = parseYaml(raw);

  const result = CrewConfigSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigurationError(
      `Invalid crew configuration:\n${issues}`,
    );
  }

  return result.data;
}

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
  readonly #runtimeDb: RuntimeDb;
  readonly #auditRepository: SqliteAuditRepository;

  readonly #channelProvider: ChannelProvider;
  readonly #mcpClient: MCPClient;
  readonly #mcpToolRegistry: McpToolRegistry;
  readonly #sessionManager: SessionManagerImpl;
  readonly #breadcrumbManager: BreadcrumbManager;
  readonly #auditLogger: AuditLogger;
  readonly #toolPolicyEnforcer: ToolPolicyEnforcer;

  readonly #instancePool: InstancePoolImpl;

  #started = false;

  constructor(
    config: CrewConfig,
    logger?: Logger,
    eventBus?: EventBus,
  ) {
    this.#config = config;

    // DESIGN: The composition root validates configured profile IDs before
    // runtime routing. Rationale: SessionManager should receive policy, not
    // own global profile loading or magic fallback identifiers.
    loadProfile(config.sessions.fallbackProfileId);

    // 1. Infrastructure
    this.#logger = logger ?? new FakeLogger();
    this.#eventBus = eventBus ?? new FakeEventBus();

    // Build the GatewayConfig subset for pi-service
    this.#gatewayConfig = loadConfig({
      database: config.database,
      den: config.den,
      health: config.health,
      logging: config.logging,
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
    const sessionStore = new SqliteSessionRepository(
      this.#runtimeDb.handle,
      this.#logger,
    );
    this.#auditRepository = new SqliteAuditRepository(this.#runtimeDb.handle);

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
    const denConnection = buildDenConnection(
      config.den,
      this.#logger,
      cursorStore,
    );
    this.#channelProvider = new DenChannelsAdapter(
      denConnection,
      this.#logger,
      { name: "Den Channels Gateway" } satisfies DenChannelsAdapterConfig,
    );

    // 3. MCP client + tool registry
    this.#mcpClient = new MCPClient(this.#logger, this.#eventBus);
    this.#mcpToolRegistry = new McpToolRegistry(this.#logger);

    // 4. Instance pool + factory
    const instanceFactory = new InstanceFactoryImpl(this.#logger);
    this.#instancePool = new InstancePoolImpl(
      instanceFactory,
      {
        maxPerProfile: config.sessions.maxPerProfile,
        maxTotal: config.sessions.maxTotal,
        idleTimeoutMs: config.sessions.idleTimeoutMs,
      },
      this.#logger,
    );

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

    this.#auditLogger = new AuditLogger(
      this.#eventBus,
      this.#logger,
      {
        writer: (entry) => {
          void this.#auditRepository.write({
            sessionId: entry.correlation.sessionId,
            assignmentId: entry.correlation.assignmentId?.toString(),
            eventType: entry.event,
            eventData: auditEntryToRecord(entry),
          });
        },
      },
    );

    // 8. Tool policy enforcer (runtime tool filtering)
    this.#toolPolicyEnforcer = new ToolPolicyEnforcer(
      this.#eventBus,
      this.#logger,
    );

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
}

function auditEntryToRecord(entry: AuditEntry): Record<string, unknown> {
  return {
    timestamp: entry.timestamp,
    event: entry.event,
    payload: entry.payload,
    correlation: entry.correlation,
  };
}

// ── Den connection factory ───────────────────────────────────────

/**
 * Build a Den connection from configuration.
 *
 * Protocol detection:
 * - `channelsUrl` starts with `ws://` or `wss://` → {@link DenWebSocketConnection}
 * - `channelsUrl` starts with `http://` or `https://` → {@link DenHttpDirectAgentConnection}
 * - `channelsUrl` is empty → {@link SimulatedDenConnection} (tests/dev)
 *
 * **HTTP mode fails closed** when `channelsProjectId` or
 * `channelsMemberIdentity` are empty — no silent fallback to simulated.
 *
 * @param den — Validated Den connectivity config.
 * @param logger — Logger for the connection.
 * @param cursorStore — Cursor persistence (required for HTTP mode).
 * @returns A DenConnection ready to be wrapped by DenChannelsAdapter.
 */
function buildDenConnection(
  den: DenConfig,
  logger: Logger,
  cursorStore: CursorStore,
): DenConnection {
  if (den.channelsUrl.length === 0) {
    logger.info("No channelsUrl configured — using simulated connection");
    return new SimulatedDenConnection(logger);
  }

  const url = new URL(den.channelsUrl);

  if (url.protocol === "ws:" || url.protocol === "wss:") {
    logger.info("Creating live Den WebSocket connection", {
      url: den.channelsUrl,
      hasToken: den.channelsToken.length > 0,
    });
    const connConfig: DenConnectionConfig = {
      url: den.channelsUrl,
      token: den.channelsToken,
      retryPolicy: {
        maxAttempts: den.channelsRetryMaxAttempts,
        baseDelayMs: den.channelsRetryBaseDelayMs,
        maxDelayMs: den.channelsRetryMaxDelayMs,
      },
      pingIntervalMs: den.channelsPingIntervalMs,
      connectionTimeoutMs: den.channelsConnectionTimeoutMs,
    };
    return new DenWebSocketConnection(connConfig, logger);
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    // Validate required HTTP fields.
    if (den.channelsProjectId.length === 0) {
      throw new ConfigurationError(
        "den.channelsProjectId is required when channelsUrl uses http:// or https://",
      );
    }
    if (den.channelsMemberIdentity.length === 0) {
      throw new ConfigurationError(
        "den.channelsMemberIdentity is required when channelsUrl uses http:// or https://",
      );
    }

    logger.info("Creating live Den HTTP direct-agent connection", {
      baseUrl: den.channelsUrl,
      projectId: den.channelsProjectId,
      memberIdentity: den.channelsMemberIdentity,
      pollIntervalMs: den.channelsPollIntervalMs,
      pollLimit: den.channelsPollLimit,
    });

    const httpConfig: DenHttpConnectionConfig = {
      baseUrl: den.channelsUrl,
      projectId: den.channelsProjectId,
      memberIdentity: den.channelsMemberIdentity,
      token: den.channelsToken,
      pollIntervalMs: den.channelsPollIntervalMs,
      pollLimit: den.channelsPollLimit,
    };

    return new DenHttpDirectAgentConnection(
      httpConfig,
      logger,
      cursorStore,
    );
  }

  throw new ConfigurationError(
    `Unsupported channelsUrl protocol: ${url.protocol}`,
  );
}

// ── SQLite-backed CursorStore ────────────────────────────────────

/**
 * Create a {@link CursorStore} that persists direct-agent event
 * cursors in the `runtime_kv` table.
 *
 * Uses `INSERT OR REPLACE` semantics so every write is durable.
 */
function createSqliteCursorStore(runtimeDb: RuntimeDb): CursorStore {
  const db = runtimeDb.handle;
  const readStmt = db.prepare(
    "SELECT value FROM runtime_kv WHERE key = ?",
  );
  const writeStmt = db.prepare(
    "INSERT OR REPLACE INTO runtime_kv (key, value, updated_at) VALUES (?, ?, ?)",
  );

  return {
    read(key: string): Promise<string | null> {
      const row = readStmt.get(key) as { value: string } | undefined;
      return Promise.resolve(row?.value ?? null);
    },
    write(key: string, value: string): Promise<void> {
      writeStmt.run(key, value, new Date().toISOString());
      return Promise.resolve();
    },
  };
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
