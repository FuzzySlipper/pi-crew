/**
 * Tests for the dynamic ToolRegistry.
 *
 * Covers: MCP tool replacement, static tool registration, name
 * collision priority (MCP wins), unregistration, listing, clearing,
 * and count/size tracking.
 *
 * @module pi-mcp/tool-registry.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { ToolRegistry } from "./tool-registry.js";
import type { AgentTool } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeTool(name: string, description?: string): AgentTool {
  return {
    name,
    description: description ?? `Tool: ${name}`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  let registry: ToolRegistry;
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
    registry = new ToolRegistry(logger);
  });

  // ── MCP tools ──────────────────────────────────────────────

  describe("setMcpTools", () => {
    it("replaces all MCP tools", () => {
      registry.setMcpTools([makeTool("a"), makeTool("b")]);

      expect(registry.mcpToolCount).toBe(2);
      expect(registry.get("a")).toBeDefined();
      expect(registry.get("b")).toBeDefined();
    });

    it("overwrites previous MCP tools", () => {
      registry.setMcpTools([makeTool("a")]);
      registry.setMcpTools([makeTool("x"), makeTool("y")]);

      expect(registry.mcpToolCount).toBe(2);
      expect(registry.get("a")).toBeUndefined();
      expect(registry.get("x")).toBeDefined();
      expect(registry.get("y")).toBeDefined();
    });

    it("clears MCP tools when given empty array", () => {
      registry.setMcpTools([makeTool("a"), makeTool("b")]);
      registry.setMcpTools([]);

      expect(registry.mcpToolCount).toBe(0);
    });

    it("logs tool count after update", () => {
      registry.setMcpTools([makeTool("a"), makeTool("b"), makeTool("c")]);

      const infoLogs = logger.entries.filter((e) => e.level === "info");
      expect(infoLogs).toHaveLength(1);
      expect(infoLogs.at(0)?.context).toMatchObject({
        mcpToolCount: 3,
        staticToolCount: 0,
      });
    });
  });

  // ── Static tools ───────────────────────────────────────────

  describe("registerStatic", () => {
    it("registers a static tool", () => {
      registry.registerStatic(makeTool("static_a"));

      expect(registry.get("static_a")).toBeDefined();
    });

    it("does not overwrite MCP tool with same name", () => {
      registry.setMcpTools([makeTool("shared", "from-mcp")]);
      registry.registerStatic(makeTool("shared", "from-static"));

      const tool = registry.get("shared");

      expect(tool).toBeDefined();
      expect(tool?.description).toBe("from-mcp");
    });

    it("static tool is reachable when no MCP tool exists", () => {
      registry.registerStatic(makeTool("only_static"));

      const tool = registry.get("only_static");

      expect(tool).toBeDefined();
      expect(tool?.name).toBe("only_static");
    });

    it("static tool becomes reachable after MCP tools cleared", () => {
      registry.setMcpTools([makeTool("shared", "mcp-ver")]);
      registry.registerStatic(makeTool("shared", "static-ver"));
      registry.setMcpTools([]);

      const tool = registry.get("shared");

      expect(tool).toBeDefined();
      expect(tool?.description).toBe("static-ver");
    });

    it("logs debug on registration", () => {
      registry.registerStatic(makeTool("logged"));

      const debugLogs = logger.entries.filter((e) => e.level === "debug");
      expect(debugLogs).toHaveLength(1);
      expect(debugLogs.at(0)?.context).toMatchObject({ toolName: "logged" });
    });
  });

  // ── Unregister ─────────────────────────────────────────────

  describe("unregisterStatic", () => {
    it("removes a registered static tool", () => {
      registry.registerStatic(makeTool("temp"));
      const removed = registry.unregisterStatic("temp");

      expect(removed).toBe(true);
      expect(registry.get("temp")).toBeUndefined();
    });

    it("returns false when tool does not exist", () => {
      expect(registry.unregisterStatic("nope")).toBe(false);
    });

    it("does not affect MCP tools", () => {
      registry.setMcpTools([makeTool("keep_me")]);
      registry.unregisterStatic("keep_me");

      expect(registry.get("keep_me")).toBeDefined();
    });
  });

  // ── Lookup ─────────────────────────────────────────────────

  describe("get", () => {
    it("returns undefined for unknown tool", () => {
      expect(registry.get("unknown")).toBeUndefined();
    });

    it("returns MCP tool when both sources have it", () => {
      registry.setMcpTools([makeTool("dup", "mcp")]);
      registry.registerStatic(makeTool("dup", "static"));

      expect(registry.get("dup")?.description).toBe("mcp");
    });
  });

  // ── Listing ────────────────────────────────────────────────

  describe("listNames", () => {
    it("returns empty array for empty registry", () => {
      expect(registry.listNames()).toEqual([]);
    });

    it("returns all unique MCP + static names", () => {
      registry.setMcpTools([makeTool("mcp_a"), makeTool("shared")]);
      registry.registerStatic(makeTool("shared"));
      registry.registerStatic(makeTool("static_b"));

      const names = registry.listNames().sort();

      expect(names).toEqual(["mcp_a", "shared", "static_b"]);
    });
  });

  describe("listTools", () => {
    it("returns tools with MCP first, no duplicates", () => {
      registry.setMcpTools([makeTool("mcp_x")]);
      registry.registerStatic(makeTool("static_y"));
      registry.registerStatic(makeTool("mcp_x")); // duplicate

      const tools = registry.listTools();

      expect(tools).toHaveLength(2);
      expect(tools.at(0)?.name).toBe("mcp_x");
      expect(tools.at(1)?.name).toBe("static_y");
    });
  });

  // ── Bulk operations ────────────────────────────────────────

  describe("clear", () => {
    it("removes all tools", () => {
      registry.setMcpTools([makeTool("a"), makeTool("b")]);
      registry.registerStatic(makeTool("c"));
      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.mcpToolCount).toBe(0);
      expect(registry.listNames()).toEqual([]);
    });
  });

  describe("size", () => {
    it("counts unique tools across sources", () => {
      expect(registry.size).toBe(0);

      registry.setMcpTools([makeTool("a"), makeTool("b")]);
      expect(registry.size).toBe(2);

      registry.registerStatic(makeTool("b")); // duplicate
      registry.registerStatic(makeTool("c"));
      expect(registry.size).toBe(3);
    });
  });
});
