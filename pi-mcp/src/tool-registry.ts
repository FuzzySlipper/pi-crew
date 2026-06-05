/**
 * ToolRegistry — dynamic tool registry that merges MCP-discovered
 * tools with statically registered tools.
 *
 * Tools are looked up by name.  MCP tools take priority when a name
 * collision occurs (they represent live server capabilities), but
 * static tools can still be registered for fallback.
 *
 * @module pi-mcp/tool-registry
 */

import type { Logger } from "@pi-crew/core";

import type { AgentTool } from "./types.js";

// ── ToolRegistry ──────────────────────────────────────────────────

/**
 * Unified tool registry for the pi-crew agent runtime.
 *
 * Merges tools from multiple sources:
 * 1. MCP-discovered tools (dynamic, from connected MCP servers)
 * 2. Static tools (programmatically registered via `registerStatic`)
 *
 * When the same tool name exists in both sets, the MCP tool wins —
 * it represents the live server capability.
 */
export class ToolRegistry {
  /** MCP-discovered tools indexed by name. */
  private mcpTools = new Map<string, AgentTool>();

  /** Statically registered tools indexed by name. */
  private staticTools = new Map<string, AgentTool>();

  constructor(private readonly logger: Logger) {}

  // ── MCP tools ───────────────────────────────────────────────

  /**
   * Replace the set of MCP-discovered tools.
   *
   * Typically called after `discoverTools()` on the MCP client.
   */
  setMcpTools(tools: readonly AgentTool[]): void {
    this.mcpTools.clear();
    for (const tool of tools) {
      this.mcpTools.set(tool.name, tool);
    }
    this.logger.info("ToolRegistry updated MCP tools", {
      mcpToolCount: this.mcpTools.size,
      staticToolCount: this.staticTools.size,
    });
  }

  /** Get the current count of MCP-discovered tools. */
  get mcpToolCount(): number {
    return this.mcpTools.size;
  }

  // ── Static tools ────────────────────────────────────────────

  /**
   * Register a static (non-MCP) tool.
   *
   * If an MCP tool with the same name exists, it takes priority during
   * lookup, but the static tool is preserved for when the MCP server
   * disconnects or the tool is removed.
   */
  registerStatic(tool: AgentTool): void {
    this.staticTools.set(tool.name, tool);
    this.logger.debug("ToolRegistry registered static tool", {
      toolName: tool.name,
    });
  }

  /**
   * Unregister a static tool by name.
   *
   * Does not affect MCP-discovered tools.
   */
  unregisterStatic(name: string): boolean {
    const existed = this.staticTools.has(name);
    this.staticTools.delete(name);
    return existed;
  }

  // ── Lookup ──────────────────────────────────────────────────

  /**
   * Get a tool by name.
   *
   * MCP-discovered tools take priority over static tools.
   *
   * @returns The tool definition, or undefined if not found.
   */
  get(name: string): AgentTool | undefined {
    return this.mcpTools.get(name) ?? this.staticTools.get(name);
  }

  /**
   * List all known tool names (both MCP and static).
   *
   * MCP tools appear first, then static tools.
   * Duplicates are excluded (MCP wins).
   */
  listNames(): string[] {
    const names = new Set<string>();

    for (const name of this.mcpTools.keys()) {
      names.add(name);
    }
    for (const name of this.staticTools.keys()) {
      names.add(name);
    }

    return [...names];
  }

  /**
   * List all registered tools, with MCP tools first.
   */
  listTools(): AgentTool[] {
    const tools: AgentTool[] = [];
    const seen = new Set<string>();

    for (const [name, tool] of this.mcpTools) {
      tools.push(tool);
      seen.add(name);
    }

    for (const [name, tool] of this.staticTools) {
      if (!seen.has(name)) {
        tools.push(tool);
      }
    }

    return tools;
  }

  // ── Bulk operations ─────────────────────────────────────────

  /**
   * Clear all tools (both MCP and static).
   */
  clear(): void {
    this.mcpTools.clear();
    this.staticTools.clear();
    this.logger.debug("ToolRegistry cleared all tools");
  }

  /** Total number of unique tools across both sources. */
  get size(): number {
    return this.listNames().length;
  }
}
