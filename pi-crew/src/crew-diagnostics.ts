/** Diagnostics wiring for the pi-crew composition root. */
import type { EventBus, ChannelProvider } from "@pi-crew/core";
import {
  DiagnosticsService,
  InMemoryDiagnosticEventJournal,
  type DenAssignmentReader,
  type DiagnosticStatusReader,
  type RuntimeDb,
  type RuntimeHealthReader,
  type SessionStore,
} from "@pi-crew/service";
import { MCPClient } from "@pi-crew/mcp";

interface CrewDiagnosticsDeps {
  readonly eventBus: EventBus;
  readonly runtimeDb: RuntimeDb;
  readonly sessionStore: SessionStore;
  readonly channelProvider: ChannelProvider;
  readonly mcpClient: MCPClient;
  readonly denCoreUrl: string;
}

export function createCrewDiagnostics(deps: CrewDiagnosticsDeps): DiagnosticsService {
  return new DiagnosticsService({
    sessionStore: deps.sessionStore,
    eventJournal: new InMemoryDiagnosticEventJournal(deps.eventBus),
    runtimeHealthReader: new RuntimeDbStatusReader(deps.runtimeDb),
    denCoreStatusReader: new DenCoreStatusReader(deps.denCoreUrl),
    denChannelsStatusReader: new DenChannelsStatusReader(deps.channelProvider),
    mcpStatusReader: new McpStatusReader(deps.mcpClient),
    denAssignmentReader: new EmptyDenAssignmentReader(),
    startedAt: new Date().toISOString(),
    version: "pi-crew",
  });
}

class RuntimeDbStatusReader implements RuntimeHealthReader {
  readonly #runtimeDb: RuntimeDb;

  constructor(runtimeDb: RuntimeDb) {
    this.#runtimeDb = runtimeDb;
  }

  health() {
    const health = this.#runtimeDb.health();
    if (!this.#runtimeDb.isOpen) return { status: "failed", error: "runtime db is closed" } as const;
    return {
      status: "ok",
      path: health.path,
      walEnabled: health.walEnabled,
      tableCount: health.tableCount,
      schemaVersion: health.schemaVersion,
    } as const;
  }
}

/**
 * Lazy Den Core reachability check via HTTP GET.
 *
 * Returns "ok" if Den responds with HTTP < 500, "degraded" if a
 * timeout/network error occurs (Den might be starting), and
 * "unreachable" on persistent 5xx responses.
 */
class DenCoreStatusReader implements DiagnosticStatusReader {
  readonly #coreUrl: string;
  #lastOkAt: string | null = null;

  constructor(coreUrl: string) {
    this.#coreUrl = coreUrl;
  }

  async readStatus(): Promise<{ status: "ok" | "degraded" | "unreachable"; lastOkAt: string | null }> {
    try {
      const response = await fetch(this.#coreUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status < 500) {
        this.#lastOkAt = new Date().toISOString();
        return { status: "ok", lastOkAt: this.#lastOkAt };
      }
      return { status: "unreachable", lastOkAt: this.#lastOkAt };
    } catch {
      // Network error or timeout — degraded, not unreachable (might be restarting)
      return { status: "degraded", lastOkAt: this.#lastOkAt };
    }
  }
}

/**
 * Den Channels reachability via the channel provider's isConnected.
 */
class DenChannelsStatusReader implements DiagnosticStatusReader {
  readonly #channelProvider: ChannelProvider;
  #lastOkAt: string | null = null;

  constructor(channelProvider: ChannelProvider) {
    this.#channelProvider = channelProvider;
  }

  readStatus(): Promise<{ status: "ok" | "degraded" | "unreachable"; lastOkAt: string | null }> {
    const connected = this.#channelProvider.isConnected;
    if (connected) {
      this.#lastOkAt = new Date().toISOString();
      return Promise.resolve({ status: "ok", lastOkAt: this.#lastOkAt });
    }
    return Promise.resolve({ status: "degraded", lastOkAt: this.#lastOkAt });
  }
}

/**
 * MCP server reachability via the MCP client's isConnected.
 */
class McpStatusReader implements DiagnosticStatusReader {
  readonly #mcpClient: MCPClient;
  #lastOkAt: string | null = null;

  constructor(mcpClient: MCPClient) {
    this.#mcpClient = mcpClient;
  }

  readStatus(): Promise<{ status: "ok" | "degraded" | "unreachable"; lastOkAt: string | null }> {
    const connected = this.#mcpClient.isConnected;
    if (connected) {
      this.#lastOkAt = new Date().toISOString();
      return Promise.resolve({ status: "ok", lastOkAt: this.#lastOkAt });
    }
    return Promise.resolve({ status: "degraded", lastOkAt: this.#lastOkAt });
  }
}

class EmptyDenAssignmentReader implements DenAssignmentReader {
  checkAssignments() {
    return Promise.resolve([]);
  }
}
