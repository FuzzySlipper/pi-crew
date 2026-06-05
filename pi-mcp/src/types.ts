/**
 * pi-mcp domain types.
 *
 * Defines the AgentTool contract for tool discovery/execution and
 * supporting types used by the MCP client, converter, and registry.
 *
 * @module pi-mcp/types
 */

import type {
  Tool as MCPTool,
  ToolAnnotations,
  CallToolResult as MCPCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

// ── AgentTool ────────────────────────────────────────────────────

/**
 * A tool definition consumable by pi-agent-core agents.
 *
 * Derived from an MCP {@link MCPTool} via {@link convertTool}.
 */
export interface AgentTool {
  /** Unique machine-readable name (e.g. "den_create_task"). */
  readonly name: string;

  /** Human-readable description shown to the agent. */
  readonly description: string;

  /**
   * JSON Schema object describing the tool's input parameters.
   *
   * Follows the JSON Schema 2020-12 convention:
   * - `type: "object"` at the root
   * - `properties` map for each parameter
   * - `required` array for mandatory parameters
   */
  readonly inputSchema: Record<string, unknown>;

  /** Optional MCP tool annotations (read-only, destructive, etc.). */
  readonly annotations?: ToolAnnotations;
}

// ── Tool call result ─────────────────────────────────────────────

/**
 * Structured result returned by {@link MCPClient.callTool}.
 */
export interface ToolCallResult {
  /** Whether the tool call succeeded. */
  readonly ok: boolean;

  /** The content blocks returned by the MCP server. */
  readonly content: ReadonlyArray<ToolCallContentBlock>;

  /** Error message when `ok` is false. */
  readonly error?: string;
}

/** A single content block within a tool call result. */
export type ToolCallContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ResourceContentBlock;

/** Plain-text content from a tool. */
export interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

/** Base64-encoded image content. */
export interface ImageContentBlock {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/** Embedded or linked resource content. */
export interface ResourceContentBlock {
  readonly type: "resource";
  readonly resource: {
    readonly uri: string;
    readonly mimeType?: string;
    readonly text?: string;
    readonly blob?: string;
  };
}

// ── Configuration ─────────────────────────────────────────────────

/** Transport kind for connecting to an MCP server. */
export type TransportKind = "stdio" | "streamable-http";

/**
 * Configuration for connecting to an MCP server.
 */
export interface ServerConfig {
  /** Human-readable server identifier. */
  readonly name: string;

  /** Transport to use for the connection. */
  readonly transport: TransportKind;

  // ── stdio ──
  /** Command to spawn (stdio transport). */
  readonly command?: string;
  /** CLI arguments (stdio transport). */
  readonly args?: readonly string[];
  /** Environment variables to pass (stdio transport). */
  readonly env?: Record<string, string>;

  // ── HTTP ──
  /** Base URL for HTTP/StreamableHTTP transport. */
  readonly endpoint?: string;

  /** Optional auth token sent as Bearer. */
  readonly authToken?: string;

  /** Timeout in ms for individual requests (default 30_000). */
  readonly requestTimeout?: number;

  /** Maximum retry attempts for reconnect (default 3). */
  readonly maxReconnectAttempts?: number;

  /** Base delay in ms for reconnect backoff (default 1_000). */
  readonly reconnectBaseDelay?: number;
}

// ── Re-exports for convenience ────────────────────────────────────

export type { MCPTool, ToolAnnotations, MCPCallToolResult };
