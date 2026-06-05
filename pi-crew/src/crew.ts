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
  loadConfig,
  GatewayConfigSchema,
  Gateway,
  createServiceRegistry,
  SessionManagerImpl,
  AgentFactoryImpl,
  InstancePoolImpl,
  InstanceFactoryImpl,
  InMemorySessionStore,
  type GatewayConfig,
  type ServiceRegistry,
} from "@pi-crew/service";

import {
  DenChannelsAdapter,
  SimulatedDenConnection,
  type DenChannelsAdapterConfig,
} from "@pi-crew/channels";

import { MCPClient, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import type { ServerConfig } from "@pi-crew/mcp";

import { BreadcrumbManager, AuditLogger } from "@pi-crew/governance";

import { ToolPolicyEnforcer } from "@pi-crew/tools";

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
  channels: z
    .object({
      denChannels: z
        .object({
          url: z.string().optional(),
          token: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
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

    // 2. Channel provider (Den Channels adapter)
    const simConnection = new SimulatedDenConnection(this.#logger);
    this.#channelProvider = new DenChannelsAdapter(
      simConnection,
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

    // 5. Session store + agent factory + session manager
    const sessionStore = new InMemorySessionStore();
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

    const auditEntries: Array<Record<string, unknown>> = [];
    this.#auditLogger = new AuditLogger(
      this.#eventBus,
      this.#logger,
      {
        writer: (entry) => {
          auditEntries.push(entry as unknown as Record<string, unknown>);
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
    if (!this.#started) return;

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
