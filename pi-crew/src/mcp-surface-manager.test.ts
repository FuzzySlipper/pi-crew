/** Tests for session-preserving MCP surface reloads. */
import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { MCPClient, AgentTool, ServerConfig } from "@pi-crew/mcp";
import type { Profile } from "@pi-crew/profiles";
import { DefaultMcpSurfaceManager } from "./mcp-surface-manager.js";

const profile: Profile = {
  id: "prime-coder",
  name: "Prime Coder",
  description: "test",
  systemPrompt: "test",
  skills: [],
  mcpConfig: { toolProfile: "runner" },
};

describe("DefaultMcpSurfaceManager", () => {
  it("reloads the profile MCP tool surface and emits typed before/after evidence", async () => {
    const bus = new FakeEventBus();
    const client = new ScriptedMcpClient([[tool("get_task")], [tool("get_task"), tool("send_message")]]);
    const manager = new DefaultMcpSurfaceManager({
      config: config(),
      logger: new FakeLogger(),
      eventBus: bus,
      clientFactory: () => client as unknown as MCPClient,
    });

    const surface = manager.surfaceForProfile(profile);
    await manager.connectAll([profile]);
    expect(surface.registry.listNames()).toEqual(["get_task"]);

    const outcome = await manager.reloadForProfile(profile, {
      sessionId: "sess-prime-coder",
      profileId: "prime-coder",
      requestedBy: "pi-crew-runner",
      reason: "test reload",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.sessionId).toBe("sess-prime-coder");
    expect(outcome.oldToolNames).toEqual(["get_task"]);
    expect(outcome.newToolNames).toEqual(["get_task", "send_message"]);
    expect(outcome.addedToolNames).toEqual(["send_message"]);
    expect(surface.registry.listNames()).toEqual(["get_task", "send_message"]);
    expect(bus.emitted.map((event) => event.event)).toEqual([
      "mcp.reload.started",
      "mcp.reload.completed",
    ]);
    expect(bus.emitted[1]?.payload).toMatchObject({
      sessionId: "sess-prime-coder",
      profileId: "prime-coder",
      requestedBy: "pi-crew-runner",
      reason: "test reload",
      addedToolNames: ["send_message"],
    });
  });

  it("does not carry session-reset fields in reload outcome evidence", async () => {
    const manager = new DefaultMcpSurfaceManager({
      config: config(),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      clientFactory: () => new ScriptedMcpClient([[tool("after")]]) as unknown as MCPClient,
    });

    const outcome = await manager.reloadForProfile(profile, {
      sessionId: "sess-prime-coder",
      profileId: "prime-coder",
      requestedBy: "pi-crew-runner",
      reason: "no reset",
    });

    expect(Object.keys(outcome)).not.toContain("oldSessionId");
    expect(Object.keys(outcome)).not.toContain("newSessionId");
    expect(Object.keys(outcome)).not.toContain("archivedMessageCount");
  });
});

class ScriptedMcpClient {
  readonly #scripts: readonly (readonly AgentTool[])[];
  #connectCount = 0;

  constructor(scripts: readonly (readonly AgentTool[])[]) {
    this.#scripts = scripts;
  }

  connect(_config: ServerConfig): Promise<AgentTool[]> {
    const index = Math.min(this.#connectCount, this.#scripts.length - 1);
    this.#connectCount += 1;
    return Promise.resolve([...(this.#scripts[index] ?? [])]);
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }
}

function config() {
  return {
    transport: "streamable-http" as const,
    endpoint: "http://den/mcp",
    requestTimeout: 30_000,
    maxReconnectAttempts: 3,
    reconnectBaseDelay: 1_000,
  };
}

function tool(name: string): AgentTool {
  return { name, description: `${name} description`, inputSchema: { type: "object" } };
}
