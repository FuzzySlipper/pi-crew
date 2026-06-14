/** Per-profile MCP client/registry surfaces for pi-crew agents. */
import { MCPClient, ToolRegistry as McpToolRegistry, type ServerConfig } from "@pi-crew/mcp";
import type { Logger, EventBus } from "@pi-crew/core";
import type { Profile } from "@pi-crew/profiles";
import type { CrewConfig } from "./config.js";

export interface McpSurface {
  readonly endpoint: string;
  readonly toolProfile?: string;
  readonly client: MCPClient;
  readonly registry: McpToolRegistry;
}

export interface McpSurfaceManager {
  surfaceForProfile(profile: Profile): McpSurface;
  connectAll(profiles: readonly Profile[]): Promise<void>;
  disconnectAll(): Promise<void>;
}

export class DefaultMcpSurfaceManager implements McpSurfaceManager {
  readonly #config: CrewConfig["mcp"];
  readonly #logger: Logger;
  readonly #eventBus: EventBus;
  readonly #surfaces = new Map<string, McpSurface>();

  constructor(input: { readonly config: CrewConfig["mcp"]; readonly logger: Logger; readonly eventBus: EventBus }) {
    this.#config = input.config;
    this.#logger = input.logger;
    this.#eventBus = input.eventBus;
  }

  surfaceForProfile(profile: Profile): McpSurface {
    const endpoint = endpointForProfile(this.#config.endpoint, profile);
    const cached = this.#surfaces.get(endpoint);
    if (cached !== undefined) return cached;
    const surface = {
      endpoint,
      toolProfile: profile.mcpConfig?.toolProfile,
      client: new MCPClient(this.#logger, this.#eventBus),
      registry: new McpToolRegistry(this.#logger),
    } satisfies McpSurface;
    this.#surfaces.set(endpoint, surface);
    return surface;
  }

  async connectAll(profiles: readonly Profile[]): Promise<void> {
    for (const profile of profiles) {
      const surface = this.surfaceForProfile(profile);
      await this.connectSurface(surface);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const surface of this.#surfaces.values()) {
      await surface.client.disconnect();
    }
  }

  private async connectSurface(surface: McpSurface): Promise<void> {
    try {
      const serverConfig: ServerConfig = {
        name: `den-mcp:${surface.toolProfile ?? "default"}`,
        transport: this.#config.transport,
        endpoint: surface.endpoint,
        requestTimeout: this.#config.requestTimeout,
        maxReconnectAttempts: this.#config.maxReconnectAttempts,
        reconnectBaseDelay: this.#config.reconnectBaseDelay,
      };
      const tools = await surface.client.connect(serverConfig);
      surface.registry.setMcpTools(tools);
    } catch (error: unknown) {
      this.#logger.warn("MCP surface connection failed", {
        endpoint: surface.endpoint,
        error: (error as Error).message,
      });
    }
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
