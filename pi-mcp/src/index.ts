// pi-mcp — MCP client for connecting to MCP servers (e.g. den-mcp).
// Depends on: pi-core, @modelcontextprotocol/sdk
//
// This barrel re-exports every public symbol from the individual
// source modules so consumers can write:
//
//   import { MCPClient, ToolRegistry, convertTool } from "@pi-crew/mcp";

// ── Types ────────────────────────────────────────────────────────
export {
  type AgentTool,
  type ToolCallResult,
  type ToolCallContentBlock,
  type TextContentBlock,
  type ImageContentBlock,
  type ResourceContentBlock,
  type TransportKind,
  type ServerConfig,
} from "./types.js";

// ── Connection ────────────────────────────────────────────────────
export { MCPConnection } from "./connection.js";

// ── Client ────────────────────────────────────────────────────────
export { MCPClient } from "./client.js";

// ── Tool converter ────────────────────────────────────────────────
export { convertTool, convertTools } from "./tool-converter.js";

// ── Tool registry ─────────────────────────────────────────────────
export { ToolRegistry } from "./tool-registry.js";
