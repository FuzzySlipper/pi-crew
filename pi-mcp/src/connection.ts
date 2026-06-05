/**
 * MCPConnection — manages MCP transport lifecycle and reconnection.
 *
 * Supports stdio (subprocess) and streamable-HTTP transports.
 * Provides backpressure-aware connect/disconnect with exponential
 * backoff on transient failures.
 *
 * @module pi-mcp/connection
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "@pi-crew/core";

import type { ServerConfig } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_MAX_RECONNECT = 3;
const DEFAULT_BASE_DELAY = 1_000;
const MAX_BACKOFF_DELAY = 30_000;
// ── MCPConnection ─────────────────────────────────────────────────

/**
 * Manages the transport lifecycle for a single MCP server connection.
 *
 * Creates the appropriate transport (stdio or streamable-HTTP), wraps it
 * in an MCP {@link Client}, handles initialisation, and provides reconnect
 * with exponential backoff.
 */
export class MCPConnection {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly logger: Logger,
  ) {}

  // ── Public API ──────────────────────────────────────────────

  /** True when the connection has been explicitly closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** The underlying MCP Client, or null before connect. */
  get mcpClient(): Client | null {
    return this.client;
  }

  /**
   * Create transport, initialise client, and connect to the server.
   *
   * @returns The connected MCP {@link Client} instance.
   */
  async connect(): Promise<Client> {
    if (this.closed) {
      throw new Error("MCPConnection is closed; create a new instance to reconnect");
    }

    if (this.client) {
      return this.client;
    }

    this.logger.info("MCPConnection connecting", {
      serverName: this.config.name,
      transport: this.config.transport,
    });

    this.transport = this.createTransport();

    this.client = new Client(
      { name: "pi-crew-mcp", version: "0.1.0" },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    this.reconnectAttempts = 0;

    this.logger.info("MCPConnection connected", {
      serverName: this.config.name,
    });

    return this.client;
  }

  /**
   * Disconnect and clean up the transport.
   *
   * Idempotent — safe to call multiple times.
   */
  async disconnect(): Promise<void> {
    this.closed = true;
    this.cancelReconnect();

    try {
      if (this.client) {
        await this.client.close();
      }
    } catch (err) {
      this.logger.warn("Error closing MCP client", {
        serverName: this.config.name,
        error: formatError(err),
      });
    }

    this.client = null;
    this.transport = null;
    this.logger.info("MCPConnection disconnected", {
      serverName: this.config.name,
    });
  }

  /**
   * Attempt reconnection with exponential backoff.
   *
   * Returns the client on success, or throws after exhausting
   * `maxReconnectAttempts`.
   */
  async reconnect(): Promise<Client> {
    const maxAttempts =
      this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT;

    if (this.closed) {
      throw new Error("Cannot reconnect a closed connection");
    }

    if (this.reconnectAttempts >= maxAttempts) {
      throw new Error(
        `Reconnect failed after ${String(maxAttempts)} attempts for ${this.config.name}`,
      );
    }

    const delay = this.calculateBackoff();
    this.logger.warn("MCPConnection reconnecting", {
      serverName: this.config.name,
      attempt: this.reconnectAttempts + 1,
      maxAttempts,
      delayMs: delay,
    });

    // Clean up existing
    try {
      if (this.client) {
        await this.client.close();
      }
    } catch {
      // Best-effort cleanup
    }
    this.client = null;
    this.transport = null;

    await sleep(delay);

    return this.connect();
  }

  // ── Transport factory ───────────────────────────────────────

  private createTransport(): Transport {
    switch (this.config.transport) {
      case "stdio":
        return this.createStdioTransport();
      case "streamable-http":
        return this.createHttpTransport();
      default:
        throw new Error(
          `Unsupported transport: ${String(this.config.transport)}`,
        );
    }
  }

  private createStdioTransport(): Transport {
    const command = this.config.command;
    if (!command) {
      throw new Error("stdio transport requires `command` in config");
    }

    return new StdioClientTransport({
      command,
      args: this.config.args ? [...this.config.args] : [],
      env: this.config.env ?? {},
      stderr: "pipe",
    });
  }

  private createHttpTransport(): Transport {
    const endpoint = this.config.endpoint;
    if (!endpoint) {
      throw new Error(
        "streamable-http transport requires `endpoint` in config",
      );
    }

    const requestTimeout =
      this.config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;

    const requestInit: RequestInit = {};
    if (this.config.authToken) {
      requestInit.headers = {
        Authorization: `Bearer ${this.config.authToken}`,
      };
    }

    return new StreamableHTTPClientTransport(
      new URL(endpoint),
      {
        requestTimeout,
        requestInit: Object.keys(requestInit).length > 0 ? requestInit : undefined,
      },
    );
  }

  // ── Backoff ─────────────────────────────────────────────────

  private calculateBackoff(): number {
    const baseDelay =
      this.config.reconnectBaseDelay ?? DEFAULT_BASE_DELAY;
    const delay = baseDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    return Math.min(delay, MAX_BACKOFF_DELAY);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
