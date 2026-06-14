import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { ToolRegistry } from "@pi-crew/mcp";
import type { Profile } from "@pi-crew/profiles";
import { DefaultMcpSurfaceManager, endpointForProfile } from "../mcp-surface-manager.js";
import { buildEffectiveToolInventory } from "../tool-inventory.js";
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
  it("lists delegated-child local code tools separately from Den MCP tools", () => {
    const inv = buildEffectiveToolInventory({
      agent: {
        agentId: "prime",
        enabled: true,
        profileId: "prime",
        profileIdentity: "prime",
        memberIdentity: "prime",
        session: { ownerId: "owner", sessionId: "sess-prime", maxHistoryMessages: 20 },
        channels: [],
        runtime: { mode: "agent", tools: { allow: ["all"] }, toolPolicy: { mode: "profile" } },
        lifecycle: { turnTimeoutMs: 1 },
      },
      profile: profile("prime", "worker-coder"),
      mcpEndpoint: "http://den/mcp?tool_profile=worker-coder",
      mcpTools: [],
      selectedToolNames: new Set(["spawn_subagent", "read_file", "write_file", "search_files", "terminal", "git_status", "git_diff"]),
    });
    const local = inv.builtInTools.filter((tool) => tool.category === "local");
    expect(local.map((tool) => tool.name)).toEqual(["read_file", "write_file", "search_files", "terminal", "git_status", "git_diff"]);
    expect(local.every((tool) => tool.modelCallable && tool.selected && tool.reason === "selected")).toBe(true);
  });

  it("lets orchestrator profiles deny local code tools while keeping Den MCP tools", () => {
    const restricted = { ...profile("runner", "runner"), toolPolicy: { mode: "deny_list" as const, deny: ["read_file", "write_file", "search_files", "terminal", "git_status", "git_diff"] } };
    const inv = buildEffectiveToolInventory({
      agent: {
        agentId: "runner",
        enabled: true,
        profileId: "runner",
        profileIdentity: "runner",
        memberIdentity: "runner",
        session: { ownerId: "owner", sessionId: "sess-runner", maxHistoryMessages: 20 },
        channels: [],
        runtime: { mode: "agent", tools: { allow: ["all"] }, toolPolicy: { mode: "profile" } },
        lifecycle: { turnTimeoutMs: 1 },
      },
      profile: restricted,
      mcpEndpoint: "http://den/mcp?tool_profile=runner",
      mcpTools: [],
      selectedToolNames: new Set(["spawn_subagent"]),
    });
    expect(inv.builtInTools.filter((tool) => tool.category === "local").map((tool) => tool.reason)).toEqual(["profile_denied", "profile_denied", "profile_denied", "profile_denied", "profile_denied", "profile_denied"]);
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
