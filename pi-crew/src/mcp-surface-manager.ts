/** Per-profile MCP client/registry surfaces for pi-crew agents. */
import { MCPClient, ToolRegistry as McpToolRegistry, type AgentTool, type ServerConfig, type ToolCallResult } from "@pi-crew/mcp";
import { ConfigurationError, type EventBus, type GatewayEvent, type Logger } from "@pi-crew/core";
import type { Profile } from "@pi-crew/profiles";
import type { CrewConfig } from "./config.js";

export interface McpSurfaceServer {
  readonly name: string;
  readonly endpoint: string;
  readonly config: ServerConfig;
  readonly toolProfile?: string;
  readonly optional: boolean;
  readonly client: MCPClient;
  readonly registry: McpToolRegistry;
  readonly discoveredToolNames: readonly string[];
  readonly error?: string;
}

export interface McpSurface {
  /** Backward-compatible primary endpoint for existing diagnostics. */
  readonly endpoint: string;
  /** Backward-compatible primary Den MCP tool profile for existing diagnostics. */
  readonly toolProfile?: string;
  readonly client: MCPClient;
  readonly registry: McpToolRegistry;
  readonly servers: readonly McpSurfaceServer[];
  readonly selectedServerNames: readonly string[];
  readonly collisions: readonly McpToolCollision[];
}

export interface McpToolCollision {
  readonly toolName: string;
  readonly serverNames: readonly string[];
}

export interface McpReloadRequest {
  readonly sessionId: string;
  readonly profileId: string;
  readonly requestedBy: string;
  readonly reason: string;
}

export interface McpReloadOutcome {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly profileId: string;
  readonly endpoint: string;
  readonly toolProfile?: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly oldToolNames: readonly string[];
  readonly newToolNames: readonly string[];
  readonly addedToolNames: readonly string[];
  readonly removedToolNames: readonly string[];
  readonly durationMs: number;
  readonly serverCount: number;
  readonly reloadedAt: string;
  readonly servers: readonly McpReloadServerOutcome[];
  readonly collisions: readonly McpToolCollision[];
  readonly error?: string;
}

export interface McpReloadServerOutcome {
  readonly name: string;
  readonly endpoint: string;
  readonly optional: boolean;
  readonly toolProfile?: string;
  readonly ok: boolean;
  readonly toolNames: readonly string[];
  readonly error?: string;
}

export interface McpSurfaceManager {
  surfaceForProfile(profile: Profile): McpSurface;
  connectAll(profiles: readonly Profile[]): Promise<void>;
  disconnectAll(): Promise<void>;
  reloadForProfile(profile: Profile, request: McpReloadRequest): Promise<McpReloadOutcome>;
}

type McpClientFactory = () => MCPClient;

interface ResolvedServerSelection {
  readonly name: string;
  readonly config: ServerConfig;
  readonly optional: boolean;
  readonly toolProfile?: string;
}

export class DefaultMcpSurfaceManager implements McpSurfaceManager {
  readonly #config: CrewConfig["mcp"];
  readonly #logger: Logger;
  readonly #eventBus: EventBus;
  readonly #clientFactory: McpClientFactory;
  readonly #surfaces = new Map<string, McpSurface>();

  constructor(input: {
    readonly config: CrewConfig["mcp"];
    readonly logger: Logger;
    readonly eventBus: EventBus;
    readonly clientFactory?: McpClientFactory;
  }) {
    this.#config = input.config;
    this.#logger = input.logger;
    this.#eventBus = input.eventBus;
    this.#clientFactory = input.clientFactory ?? (() => new MCPClient(this.#logger, this.#eventBus));
  }

  surfaceForProfile(profile: Profile): McpSurface {
    const selections = resolveServerSelections(this.#config, profile);
    const cacheKey = selections.map((selection) => selection.config.endpoint ?? selection.config.name).join("|");
    const cached = this.#surfaces.get(cacheKey);
    if (cached !== undefined) return cached;
    const servers = selections.map((selection) => ({
      name: selection.name,
      endpoint: selection.config.endpoint ?? "stdio",
      config: selection.config,
      ...(selection.toolProfile === undefined ? {} : { toolProfile: selection.toolProfile }),
      optional: selection.optional,
      client: this.#clientFactory(),
      registry: new McpToolRegistry(this.#logger),
      discoveredToolNames: [],
    } satisfies McpSurfaceServer));
    const primary = servers[0];
    if (primary === undefined) {
      throw new ConfigurationError(`Profile "${profile.id}" must select at least one MCP server`);
    }
    const surface = this.makeSurface(primary, servers, [], []);
    this.#surfaces.set(cacheKey, surface);
    return surface;
  }

  async connectAll(profiles: readonly Profile[]): Promise<void> {
    for (const profile of profiles) {
      const surface = this.surfaceForProfile(profile);
      try {
        await this.connectSurface(surface);
      } catch (error: unknown) {
        this.#logger.warn("MCP surface connection failed", {
          profileId: profile.id,
          selectedServerNames: surface.selectedServerNames,
          error: errorMessage(error),
        });
      }
    }
  }

  async disconnectAll(): Promise<void> {
    const clients = new Set<MCPClient>();
    for (const surface of this.#surfaces.values()) {
      for (const server of surface.servers) clients.add(server.client);
    }
    for (const client of clients) await client.disconnect();
  }

  async reloadForProfile(profile: Profile, request: McpReloadRequest): Promise<McpReloadOutcome> {
    const surface = this.surfaceForProfile(profile);
    const startedAt = Date.now();
    const oldToolNames = surface.registry.listNames();
    const startOutcome = this.outcome(surface, request, oldToolNames, oldToolNames, startedAt, undefined);
    this.#eventBus.emit({ event: "mcp.reload.started", payload: this.payloadFromOutcome(startOutcome) });
    try {
      for (const server of surface.servers) await server.client.disconnect();
      const reconnected = await this.connectSurface(surface);
      const newToolNames = reconnected.registry.listNames();
      const error = reconnected.collisions.length > 0 ? collisionMessage(reconnected.collisions) : undefined;
      const outcome = this.outcome(reconnected, request, oldToolNames, newToolNames, startedAt, error);
      this.#eventBus.emit({ event: error === undefined ? "mcp.reload.completed" : "mcp.reload.failed", payload: this.payloadFromOutcome(outcome) });
      return outcome;
    } catch (error: unknown) {
      surface.registry.setMcpTools([]);
      const outcome = this.outcome(surface, request, oldToolNames, surface.registry.listNames(), startedAt, errorMessage(error));
      this.#eventBus.emit({ event: "mcp.reload.failed", payload: this.payloadFromOutcome(outcome) });
      return outcome;
    }
  }

  async connectSurface(surface: McpSurface): Promise<McpSurface> {
    const connectedServers: McpSurfaceServer[] = [];
    for (const server of surface.servers) {
      const connected = await this.connectServer(server);
      connectedServers.push(connected);
    }
    const merged = mergeServerTools(connectedServers);
    const primary = connectedServers[0] ?? surface.servers[0];
    const updated = this.makeSurface(primary, connectedServers, merged.tools, merged.collisions);
    Object.assign(surface, updated);
    this.#surfaces.set(updated.selectedServerNames.map((name) => updated.servers.find((server) => server.name === name)?.endpoint ?? name).join("|"), surface);
    if (merged.collisions.length > 0) {
      surface.registry.setMcpTools([]);
      throw new ConfigurationError(collisionMessage(merged.collisions));
    }
    return surface;
  }

  payloadFromOutcome(outcome: McpReloadOutcome): Extract<GatewayEvent, { event: "mcp.reload.started" }>["payload"] {
    return {
      sessionId: outcome.sessionId,
      profileId: outcome.profileId,
      endpoint: outcome.endpoint,
      ...(outcome.toolProfile === undefined ? {} : { toolProfile: outcome.toolProfile }),
      requestedBy: outcome.requestedBy,
      reason: outcome.reason,
      oldToolNames: outcome.oldToolNames,
      newToolNames: outcome.newToolNames,
      addedToolNames: outcome.addedToolNames,
      removedToolNames: outcome.removedToolNames,
      durationMs: outcome.durationMs,
      serverCount: outcome.serverCount,
      reloadedAt: outcome.reloadedAt,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      servers: outcome.servers,
      collisions: outcome.collisions,
    };
  }

  outcome(
    surface: McpSurface,
    request: McpReloadRequest,
    oldToolNames: readonly string[],
    newToolNames: readonly string[],
    startedAt: number,
    error: string | undefined,
  ): McpReloadOutcome {
    return {
      ok: error === undefined,
      sessionId: request.sessionId,
      profileId: request.profileId,
      endpoint: surface.endpoint,
      ...(surface.toolProfile === undefined ? {} : { toolProfile: surface.toolProfile }),
      requestedBy: request.requestedBy,
      reason: request.reason,
      oldToolNames,
      newToolNames,
      addedToolNames: difference(newToolNames, oldToolNames),
      removedToolNames: difference(oldToolNames, newToolNames),
      durationMs: Date.now() - startedAt,
      serverCount: surface.servers.length,
      reloadedAt: new Date().toISOString(),
      servers: surface.servers.map((server) => ({
        name: server.name,
        endpoint: server.endpoint,
        optional: server.optional,
        ...(server.toolProfile === undefined ? {} : { toolProfile: server.toolProfile }),
        ok: server.error === undefined,
        toolNames: server.discoveredToolNames,
        ...(server.error === undefined ? {} : { error: server.error }),
      })),
      collisions: surface.collisions,
      ...(error === undefined ? {} : { error }),
    };
  }

  async connectServer(server: McpSurfaceServer): Promise<McpSurfaceServer> {
    try {
      const tools = await server.client.connect(server.config);
      server.registry.setMcpTools(tools);
      return { ...server, discoveredToolNames: tools.map((tool) => tool.name), error: undefined };
    } catch (error: unknown) {
      const message = errorMessage(error);
      server.registry.setMcpTools([]);
      if (!server.optional) throw new ConfigurationError(`Required MCP server "${server.name}" failed: ${message}`);
      this.#logger.warn("Optional MCP server connection failed", { serverName: server.name, error: message });
      return { ...server, discoveredToolNames: [], error: message };
    }
  }

  makeSurface(
    primary: McpSurfaceServer,
    servers: readonly McpSurfaceServer[],
    mergedTools: readonly AgentTool[],
    collisions: readonly McpToolCollision[],
  ): McpSurface {
    const registry = new McpToolRegistry(this.#logger);
    registry.setMcpTools(mergedTools);
    return {
      endpoint: primary.endpoint,
      ...(primary.toolProfile === undefined ? {} : { toolProfile: primary.toolProfile }),
      client: new RoutingMcpClient(servers) as unknown as MCPClient,
      registry,
      servers,
      selectedServerNames: servers.map((server) => server.name),
      collisions,
    };
  }
}

class RoutingMcpClient {
  readonly #servers: readonly McpSurfaceServer[];

  constructor(servers: readonly McpSurfaceServer[]) {
    this.#servers = servers;
  }

  async callTool(name: string, params: Record<string, unknown> = {}): Promise<ToolCallResult> {
    for (const server of this.#servers) {
      if (server.registry.get(name) !== undefined) return server.client.callTool(name, params);
    }
    return { ok: false, content: [], error: `Tool "${name}" is not available on selected MCP servers` };
  }

  async disconnect(): Promise<void> {
    for (const server of this.#servers) await server.client.disconnect();
  }
}

export function endpointForProfile(baseEndpoint: string, profile: Profile): string {
  if (profile.mcpConfig?.endpoint !== undefined) return profile.mcpConfig.endpoint;
  const toolProfile = profile.mcpConfig?.toolProfile;
  if (toolProfile === undefined || toolProfile.trim() === "") return baseEndpoint;
  return endpointWithToolProfile(baseEndpoint, toolProfile);
}

export function resolveServerSelections(config: CrewConfig["mcp"], profile: Profile): readonly ResolvedServerSelection[] {
  if (profile.mcpConfig?.endpoint !== undefined) {
    return [{
      name: "legacy-profile",
      config: legacyServerConfig(config, endpointForProfile(config.endpoint, profile), "legacy-profile"),
      optional: false,
      ...(profile.mcpConfig.toolProfile === undefined ? {} : { toolProfile: profile.mcpConfig.toolProfile }),
    }];
  }
  const catalog = serverCatalog(config);
  const defaultServer = config.defaultServer;
  const profileServers = profile.mcpConfig?.servers;
  const selected = profileServers === undefined || profileServers.length === 0
    ? [{ name: defaultServer, toolProfile: profile.mcpConfig?.toolProfile, optional: false }]
    : profileServers;
  return selected.map((selection) => {
    const base = catalog.get(selection.name);
    if (base === undefined) {
      throw new ConfigurationError(`Profile "${profile.id}" selects unknown MCP server "${selection.name}"`);
    }
    const toolProfile = selection.toolProfile ?? (selection.name === defaultServer ? profile.mcpConfig?.toolProfile : undefined);
    const endpoint = base.endpoint === undefined || toolProfile === undefined ? base.endpoint : endpointWithToolProfile(base.endpoint, toolProfile);
    return {
      name: selection.name,
      config: { ...base, endpoint },
      optional: selection.optional ?? false,
      ...(toolProfile === undefined ? {} : { toolProfile }),
    };
  });
}

function legacyServerConfig(config: CrewConfig["mcp"], endpoint: string, name: string): ServerConfig {
  return {
    name,
    transport: config.transport,
    endpoint,
    requestTimeout: config.requestTimeout,
    maxReconnectAttempts: config.maxReconnectAttempts,
    reconnectBaseDelay: config.reconnectBaseDelay,
  };
}

function serverCatalog(config: CrewConfig["mcp"]): ReadonlyMap<string, ServerConfig> {
  const servers = new Map<string, ServerConfig>();
  for (const [name, server] of Object.entries(config.servers)) {
    servers.set(name, { name, ...server });
  }
  const defaultServer = config.defaultServer;
  if (!servers.has(defaultServer)) {
    servers.set(defaultServer, legacyServerConfig(config, config.endpoint, defaultServer));
  }
  return servers;
}

function endpointWithToolProfile(endpoint: string, toolProfile: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("tool_profile", toolProfile);
  return url.toString();
}

function mergeServerTools(servers: readonly McpSurfaceServer[]): {
  readonly tools: readonly AgentTool[];
  readonly collisions: readonly McpToolCollision[];
} {
  const byName = new Map<string, { tool: AgentTool; serverNames: string[] }>();
  for (const server of servers) {
    for (const tool of server.registry.listTools()) {
      const existing = byName.get(tool.name);
      if (existing === undefined) {
        byName.set(tool.name, { tool, serverNames: [server.name] });
      } else {
        existing.serverNames.push(server.name);
      }
    }
  }
  const collisions = [...byName.entries()]
    .filter(([, value]) => value.serverNames.length > 1)
    .map(([toolName, value]) => ({ toolName, serverNames: value.serverNames }));
  if (collisions.length > 0) return { tools: [], collisions };
  return { tools: [...byName.values()].map((value) => value.tool), collisions: [] };
}

function collisionMessage(collisions: readonly McpToolCollision[]): string {
  return `MCP tool name collision(s): ${collisions.map((collision) => `${collision.toolName} from ${collision.serverNames.join(",")}`).join("; ")}`;
}

function difference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
