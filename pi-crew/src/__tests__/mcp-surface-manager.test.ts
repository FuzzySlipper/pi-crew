import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { ToolRegistry } from "@pi-crew/mcp";
import type { Profile } from "@pi-crew/profiles";
import { DefaultMcpSurfaceManager, endpointForProfile } from "../mcp-surface-manager.js";
import { selectToolsBeforeSessionPolicy } from "../tool-selection.js";

function profile(id: string, toolProfile?: string): Profile {
  return {
    id,
    name: id,
    description: id,
    systemPrompt: id,
    skills: [],
    modelConfig: { provider: "den-router", model: "grok" },
    mcpConfig: toolProfile === undefined ? undefined : { toolProfile },
    toolPolicy: { mode: "allow_all" },
  };
}

describe("MCP profile surfaces", () => {
  it("derives distinct Den MCP tool_profile endpoints per profile", () => {
    expect(endpointForProfile("http://den/mcp", profile("runner", "runner"))).toBe("http://den/mcp?tool_profile=runner");
    expect(endpointForProfile("http://den/mcp?x=1", profile("coder", "worker-coder"))).toBe("http://den/mcp?x=1&tool_profile=worker-coder");
  });

  it("caches clients by effective endpoint", () => {
    const manager = new DefaultMcpSurfaceManager({
      config: { transport: "streamable-http", endpoint: "http://den/mcp", requestTimeout: 1, maxReconnectAttempts: 1, reconnectBaseDelay: 1 },
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
    });
    expect(manager.surfaceForProfile(profile("a", "runner"))).toBe(manager.surfaceForProfile(profile("b", "runner")));
    expect(manager.surfaceForProfile(profile("a", "runner"))).not.toBe(manager.surfaceForProfile(profile("c", "worker-coder")));
  });
});

describe("tool selection naming", () => {
  it("keeps Den write tools out of the safe den category", () => {
    const registry = new ToolRegistry(new FakeLogger());
    registry.setMcpTools([
      { name: "get_task", description: "read", inputSchema: { type: "object" } },
      { name: "send_message", description: "write", inputSchema: { type: "object" } },
      { name: "update_task", description: "write", inputSchema: { type: "object" } },
    ]);
    expect(selectToolsBeforeSessionPolicy({ tools: registry.listTools(), requestedSets: ["den"], profileToolPolicy: { mode: "allow_all" } }).map((tool) => tool.name)).toEqual(["get_task"]);
  });
});
