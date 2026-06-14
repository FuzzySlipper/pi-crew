/** Per-profile MCP client/registry surfaces for pi-crew agents. */
import { MCPClient, ToolRegistry as McpToolRegistry, type ServerConfig } from "@pi-crew/mcp";
import type { EventBus, Logger, McpReloadPayload } from "@pi-crew/core";
import type { Profile } from "@pi-crew/profiles";
import type { CrewConfig } from "./config.js";

export interface McpSurface {
  readonly endpoint: string;
  readonly toolProfile?: string;
  readonly client: MCPClient;
  readonly registry: McpToolRegistry;
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
  readonly error?: string;
}

export interface McpSurfaceManager {
  surfaceForProfile(profile: Profile): McpSurface;
  connectAll(profiles: readonly Profile[]): Promise<void>;
  disconnectAll(): Promise<void>;
  reloadForProfile(profile: Profile, request: McpReloadRequest): Promise<McpReloadOutcome>;
}

type McpClientFactory = () => MCPClient;

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
    const endpoint = endpointForProfile(this.#config.endpoint, profile);
    const cached = this.#surfaces.get(endpoint);
    if (cached !== undefined) return cached;
    const surface = {
      endpoint,
      toolProfile: profile.mcpConfig?.toolProfile,
      client: this.#clientFactory(),
      registry: new McpToolRegistry(this.#logger),
    } satisfies McpSurface;
    this.#surfaces.set(endpoint, surface);
    return surface;
  }

  async connectAll(profiles: readonly Profile[]): Promise<void> {
    for (const profile of profiles) {
      const surface = this.surfaceForProfile(profile);
      try {
        await this.connectSurface(surface);
      } catch (error: unknown) {
        this.#logger.warn("MCP surface connection failed", {
          endpoint: surface.endpoint,
          error: errorMessage(error),
        });
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const surface of this.#surfaces.values()) {
      await surface.client.disconnect();
    }
  }

  async reloadForProfile(profile: Profile, request: McpReloadRequest): Promise<McpReloadOutcome> {
    const surface = this.surfaceForProfile(profile);
    const startedAt = Date.now();
    const oldToolNames = surface.registry.listNames();
    const basePayload = this.payload(surface, request, oldToolNames, oldToolNames, startedAt);
    this.#eventBus.emit({ event: "mcp.reload.started", payload: basePayload });
    try {
      await surface.client.disconnect();
      await this.connectSurface(surface);
      const newToolNames = surface.registry.listNames();
      const outcome = this.outcome(surface, request, oldToolNames, newToolNames, startedAt, undefined);
      this.#eventBus.emit({ event: "mcp.reload.completed", payload: this.payloadFromOutcome(outcome) });
      return outcome;
    } catch (error: unknown) {
      surface.registry.setMcpTools([]);
      const outcome = this.outcome(surface, request, oldToolNames, surface.registry.listNames(), startedAt, errorMessage(error));
      this.#eventBus.emit({ event: "mcp.reload.failed", payload: this.payloadFromOutcome(outcome) });
      return outcome;
    }
  }

  async connectSurface(surface: McpSurface): Promise<void> {
    const serverConfig = serverConfigForSurface(this.#config, surface);
    const tools = await surface.client.connect(serverConfig);
    surface.registry.setMcpTools(tools);
  }

  payload(
    surface: McpSurface,
    request: McpReloadRequest,
    oldToolNames: readonly string[],
    newToolNames: readonly string[],
    startedAt: number,
    error?: string,
  ): McpReloadPayload {
    return this.payloadFromOutcome(this.outcome(surface, request, oldToolNames, newToolNames, startedAt, error));
  }

  payloadFromOutcome(outcome: McpReloadOutcome): McpReloadPayload {
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
      serverCount: 1,
      reloadedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { error }),
    };
  }
}

export function endpointForProfile(baseEndpoint: string, profile: Profile): string {
  if (profile.mcpConfig?.endpoint !== undefined) return profile.mcpConfig.endpoint;
  const toolProfile = profile.mcpConfig?.toolProfile;
  if (toolProfile === undefined || toolProfile.trim() === "") return baseEndpoint;
  const url = new URL(baseEndpoint);
  url.searchParams.set("tool_profile", toolProfile);
  return url.toString();
}

function serverConfigForSurface(config: CrewConfig["mcp"], surface: McpSurface): ServerConfig {
  return {
    name: `den-mcp:${surface.toolProfile ?? "default"}`,
    transport: config.transport,
    endpoint: surface.endpoint,
    requestTimeout: config.requestTimeout,
    maxReconnectAttempts: config.maxReconnectAttempts,
    reconnectBaseDelay: config.reconnectBaseDelay,
  };
}

function difference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
