/**
 * MCPClient — high-level client for MCP server interaction.
 *
 * Provides connect/disconnect, dynamic tool discovery, and tool
 * execution.  Emits `tool.called` / `tool.completed` gateway events
 * with Den correlation metadata where available.
 *
 * @module pi-mcp/client
 */

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  Logger,
  EventBus,
  GatewayEvent,
} from "@pi-crew/core";

import { MCPConnection } from "./connection.js";
import { convertTools } from "./tool-converter.js";
import type {
  ServerConfig,
  AgentTool,
  ToolCallResult,
  ToolCallContentBlock,
} from "./types.js";

// ── MCPClient ─────────────────────────────────────────────────────

/**
 * High-level client for interacting with an MCP server.
 *
 * Wraps an {@link MCPConnection} and provides:
 * - `connect()` / `disconnect()` — lifecycle
 * - `discoverTools()` — dynamic tool schema discovery
 * - `callTool()` — typed tool execution with event emission
 */
export class MCPClient {
  private connection: MCPConnection | null = null;
  private cachedTools: AgentTool[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly eventBus?: EventBus,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────

  /**
   * Connect to an MCP server using the given configuration.
   *
   * After connecting, automatically calls {@link discoverTools} to
   * populate the tool cache.
   *
   * @returns The discovered tools.
   */
  async connect(config: ServerConfig): Promise<AgentTool[]> {
    this.logger.info("MCPClient connecting", {
      serverName: config.name,
      transport: config.transport,
    });

    this.connection = new MCPConnection(config, this.logger);
    await this.connection.connect();

    // Discover tools immediately after connecting
    this.cachedTools = await this.discoverTools();

    this.logger.info("MCPClient ready", {
      serverName: config.name,
      toolCount: this.cachedTools.length,
    });

    return this.cachedTools;
  }

  /**
   * Disconnect from the server and clear cached tools.
   *
   * Idempotent — safe to call multiple times.
   */
  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.disconnect();
      this.connection = null;
    }
    this.cachedTools = [];
    this.logger.info("MCPClient disconnected");
  }

  /** True when the client is connected. */
  get isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed;
  }

  // ── Tool discovery ─────────────────────────────────────────

  /**
   * Discover tools from the connected MCP server.
   *
   * Converts MCP tool schemas to {@link AgentTool} objects with
   * full parameter type information.
   *
   * @returns The discovered tools, or an empty array if disconnected.
   */
  async discoverTools(): Promise<AgentTool[]> {
    const client = this.connection?.mcpClient ?? null;
    if (!client) {
      this.logger.warn("discoverTools called while disconnected");
      return [];
    }

    const result = await client.listTools();
    const converted = convertTools(result.tools);

    this.logger.info("MCPClient discovered tools", {
      toolCount: converted.length,
    });

    return converted;
  }

  // ── Tool execution ─────────────────────────────────────────

  /**
   * Call a named tool on the connected MCP server.
   *
   * Emits `tool.called` before execution and `tool.completed`
   * after, including Den correlation metadata when available
   * in the result `_meta`.
   *
   * @param name - The tool name (e.g. "den_create_task").
   * @param params - Input parameters matching the tool's schema.
   * @returns A structured {@link ToolCallResult}.
   */
  async callTool(
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<ToolCallResult> {
    const client = this.connection?.mcpClient ?? null;
    if (!client) {
      return { ok: false, content: [], error: "Not connected to MCP server" };
    }

    const startedAt = Date.now();

    this.emitEvent({
      event: "tool.called",
      payload: {
        toolName: name,
        sessionId: this.configName(),
        params,
      },
    });

    try {
      const rawResult = await client.callTool(
        { name, arguments: params },
        CallToolResultSchema,
      );

      const content = extractContentBlocks(rawResult.content);
      const durationMs = Date.now() - startedAt;

      this.emitEvent({
        event: "tool.completed",
        payload: {
          toolName: name,
          sessionId: this.configName(),
          success: true,
          durationMs,
          result: content.length > 0 ? content[0] : undefined,
        },
      });

      return { ok: true, content };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = formatError(err);

      this.emitEvent({
        event: "tool.completed",
        payload: {
          toolName: name,
          sessionId: this.configName(),
          success: false,
          durationMs,
          result: errorMessage,
        },
      });

      return { ok: false, content: [], error: errorMessage };
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private configName(): string {
    return "pi-mcp";
  }

  private emitEvent(event: GatewayEvent): void {
    if (this.eventBus) {
      this.eventBus.emit(event);
    }
  }
}

// ── Content extraction ────────────────────────────────────────────

/**
 * Convert raw MCP content items to typed {@link ToolCallContentBlock}s.
 *
 * Handles text, image, and resource content types from the MCP protocol.
 */
function extractContentBlocks(
  raw: ReadonlyArray<Record<string, unknown>>,
): ToolCallContentBlock[] {
  const blocks: ToolCallContentBlock[] = [];

  for (const item of raw) {
    const type = item.type;

    if (type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
    } else if (type === "image") {
      const data = typeof item.data === "string" ? item.data : "";
      const mimeType =
        typeof item.mimeType === "string" ? item.mimeType : "image/png";
      blocks.push({
        type: "image",
        data,
        mimeType,
      });
    } else if (type === "resource") {
      const res = item.resource as Record<string, unknown> | undefined;
      const uri = typeof res?.uri === "string" ? res.uri : "";
      blocks.push({
        type: "resource",
        resource: {
          uri,
          mimeType: typeof res?.mimeType === "string" ? res.mimeType : undefined,
          text: typeof res?.text === "string" ? res.text : undefined,
          blob: typeof res?.blob === "string" ? res.blob : undefined,
        },
      });
    } else {
      // Unknown content type — preserve as text
      blocks.push({
        type: "text",
        text: JSON.stringify(item),
      });
    }
  }

  return blocks;
}

// ── Utilities ─────────────────────────────────────────────────────

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
