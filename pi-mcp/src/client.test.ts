/**
 * Tests for the MCPClient — tool discovery, execution, and events.
 *
 * Mocks the @modelcontextprotocol/sdk Client to verify:
 * - connect/disconnect lifecycle
 * - discoverTools populates cache with converted AgentTools
 * - callTool emits tool.called / tool.completed events
 * - callTool returns structured ToolCallResult on success/failure
 * - disconnect clears state gracefully
 *
 * @module pi-mcp/client.test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { MCPClient } from "./client.js";
import type { ServerConfig, AgentTool } from "./types.js";

// ── Mock SDK ─────────────────────────────────────────────────────

const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
    callTool: mockCallTool,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    onmessage: null,
    onerror: null,
    onclose: null,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    onmessage: null,
    onerror: null,
    onclose: null,
  })),
}));

// ── Helpers ──────────────────────────────────────────────────────

function httpConfig(): ServerConfig {
  return {
    name: "test-mcp",
    transport: "streamable-http",
    endpoint: "http://localhost:9999/mcp",
    requestTimeout: 5000,
  };
}

function mockDiscoverTools(tools: AgentTool[]): void {
  mockListTools.mockResolvedValue({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as {
        type: "object";
        properties?: Record<string, unknown>;
        required?: string[];
      },
    })),
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe("MCPClient", () => {
  let client: MCPClient;
  let logger: FakeLogger;
  let eventBus: FakeEventBus;

  beforeEach(() => {
    logger = new FakeLogger();
    eventBus = new FakeEventBus();
    client = new MCPClient(logger, eventBus);

    mockListTools.mockReset();
    mockCallTool.mockReset();
    mockConnect.mockReset();
    mockClose.mockReset();
  });

  // ── Lifecycle ───────────────────────────────────────────────

  describe("connect / disconnect", () => {
    it("isConnected is false before connect", () => {
      expect(client.isConnected).toBe(false);
    });

    it("connect returns discovered tools", async () => {
      mockDiscoverTools([
        { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      ]);

      const tools = await client.connect(httpConfig());

      expect(tools).toHaveLength(1);
      const tool = tools[0];
      expect(tool).toBeDefined();
      expect(tool.name).toBe("tool_a");
    });

    it("disconnect clears state and is idempotent", async () => {
      mockDiscoverTools([]);
      await client.connect(httpConfig());

      await client.disconnect();

      expect(client.isConnected).toBe(false);

      // Idempotent
      await client.disconnect();
      expect(client.isConnected).toBe(false);
    });

    it("logs connect and disconnect lifecycle", async () => {
      mockDiscoverTools([]);
      await client.connect(httpConfig());
      await client.disconnect();

      const infoMsgs = logger.entries
        .filter((e) => e.level === "info")
        .map((e) => e.message);

      expect(infoMsgs).toContain("MCPClient connecting");
      expect(infoMsgs).toContain("MCPClient ready");
      expect(infoMsgs).toContain("MCPClient disconnected");
    });
  });

  // ── Tool discovery ─────────────────────────────────────────

  describe("discoverTools", () => {
    it("returns converted AgentTool[]", async () => {
      mockDiscoverTools([
        {
          name: "search",
          description: "Search documents",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
            },
            required: ["query"],
          },
        },
      ]);

      await client.connect(httpConfig());

      const tools = await client.discoverTools();

      expect(tools).toHaveLength(1);
      const tool = tools[0];
      expect(tool).toBeDefined();
      expect(tool.name).toBe("search");
      expect(tool.inputSchema).toHaveProperty("properties");
    });

    it("returns empty array when disconnected", async () => {
      const tools = await client.discoverTools();

      expect(tools).toEqual([]);
    });

    it("logs tool count on discovery", async () => {
      mockDiscoverTools([
        { name: "a", description: "A", inputSchema: { type: "object" } },
        { name: "b", description: "B", inputSchema: { type: "object" } },
      ]);

      await client.connect(httpConfig());

      const infoLogs = logger.entries.filter((e) => e.level === "info");
      const discoveryLog = infoLogs.find(
        (e) => e.message === "MCPClient discovered tools",
      );

      expect(discoveryLog).toBeDefined();
      expect(discoveryLog?.context).toMatchObject({ toolCount: 2 });
    });
  });

  // ── Tool execution ─────────────────────────────────────────

  describe("callTool", () => {
    it("calls tool and returns success result", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "Task #42 created" }],
      });

      await client.connect(httpConfig());

      const result = await client.callTool("create_task", {
        title: "Test",
      });

      expect(result.ok).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Task #42 created" },
      ]);
    });

    it("returns error result when not connected", async () => {
      const result = await client.callTool("any_tool");

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Not connected to MCP server");
    });

    it("returns error result on call failure", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockRejectedValue(new Error("Server timeout"));

      await client.connect(httpConfig());

      const result = await client.callTool("failing_tool");

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Server timeout");
    });

    it("handles non-Error thrown values", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockRejectedValue("raw string error");

      await client.connect(httpConfig());

      const result = await client.callTool("raw_err");

      expect(result.ok).toBe(false);
      expect(result.error).toBe("raw string error");
    });
  });

  // ── Event emission ─────────────────────────────────────────

  describe("event emission", () => {
    it("emits tool.called before execution", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });

      await client.connect(httpConfig());
      eventBus.clear();
      await client.callTool("emit_test");

      const calledEvents = eventBus.emitted.filter(
        (e) => e.event === "tool.called",
      );

      expect(calledEvents).toHaveLength(1);
      expect(calledEvents.at(0)?.payload).toMatchObject({
        toolName: "emit_test",
      });
    });

    it("emits tool.completed on success", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "done" }],
      });

      await client.connect(httpConfig());
      eventBus.clear();
      await client.callTool("succeed");

      const completedEvents = eventBus.emitted.filter(
        (e) => e.event === "tool.completed",
      );

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents.at(0)?.payload).toMatchObject({
        toolName: "succeed",
        success: true,
      });
      expect(typeof completedEvents.at(0)?.payload.durationMs).toBe("number");
    });

    it("emits tool.completed on failure", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockRejectedValue(new Error("boom"));

      await client.connect(httpConfig());
      eventBus.clear();
      await client.callTool("fail");

      const completedEvents = eventBus.emitted.filter(
        (e) => e.event === "tool.completed",
      );

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents.at(0)?.payload).toMatchObject({
        toolName: "fail",
        success: false,
      });
    });

    it("does not throw when eventBus is undefined", async () => {
      const noBusClient = new MCPClient(logger);
      mockDiscoverTools([]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });

      await noBusClient.connect(httpConfig());

      // Should not throw
      const result = await noBusClient.callTool("no_bus");
      expect(result.ok).toBe(true);
    });
  });

  // ── Content extraction ─────────────────────────────────────

  describe("content extraction", () => {
    it("extracts text content", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockResolvedValue({
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      });

      await client.connect(httpConfig());
      const result = await client.callTool("multi_text");

      expect(result.content).toEqual([
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ]);
    });

    it("extracts image content", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
      });

      await client.connect(httpConfig());
      const result = await client.callTool("image_tool");

      expect(result.content).toEqual([
        { type: "image", data: "base64data", mimeType: "image/png" },
      ]);
    });

    it("extracts resource content", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockResolvedValue({
        content: [
          {
            type: "resource",
            resource: { uri: "file:///tmp/out.txt", text: "hello" },
          },
        ],
      });

      await client.connect(httpConfig());
      const result = await client.callTool("resource_tool");

      expect(result.content).toEqual([
        {
          type: "resource",
          resource: { uri: "file:///tmp/out.txt", text: "hello" },
        },
      ]);
    });

    it("falls back to text dump for unknown content type", async () => {
      mockDiscoverTools([]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "custom", customField: 42 }],
      });

      await client.connect(httpConfig());
      const result = await client.callTool("custom_type");

      expect(result.content).toHaveLength(1);
      expect(result.content.at(0)?.type).toBe("text");
      expect(result.content.at(0)).toHaveProperty("text");
    });
  });
});
