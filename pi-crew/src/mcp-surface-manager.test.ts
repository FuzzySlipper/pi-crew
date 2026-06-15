/** Tests for session-preserving MCP surface reloads. */
import { describe, expect, it } from "vitest";
import { ConfigurationError, FakeEventBus, FakeLogger } from "@pi-crew/core";
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
      serverCount: 1,
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

  it("merges selected profile MCP servers and preserves Den tool_profile endpoint", async () => {
    const clients = [
      new ScriptedMcpClient([[tool("get_task")]]),
      new ScriptedMcpClient([[tool("run_tests")]]),
    ];
    let index = 0;
    const manager = new DefaultMcpSurfaceManager({
      config: multiConfig(),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      clientFactory: () => clients[index++] as unknown as MCPClient,
    });
    const multiProfile = profileWithServers([
      { name: "den", toolProfile: "worker-coder" },
      { name: "test-runner" },
    ]);

    const surface = manager.surfaceForProfile(multiProfile);
    await manager.connectAll([multiProfile]);

    expect(surface.selectedServerNames).toEqual(["den", "test-runner"]);
    expect(surface.registry.listNames()).toEqual(["get_task", "run_tests"]);
    expect(surface.servers.map((server) => server.discoveredToolNames)).toEqual([
      ["get_task"],
      ["run_tests"],
    ]);
    expect(clients[0]?.configs[0]?.endpoint).toBe("http://den/mcp?tool_profile=worker-coder");
    expect(clients[1]?.configs[0]?.endpoint).toBe("http://runner/mcp");
  });

  it("fails closed when selected MCP servers expose colliding tool names", async () => {
    const clients = [
      new ScriptedMcpClient([[tool("same")]]),
      new ScriptedMcpClient([[tool("same")]]),
    ];
    let index = 0;
    const manager = new DefaultMcpSurfaceManager({
      config: multiConfig(),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      clientFactory: () => clients[index++] as unknown as MCPClient,
    });

    await expect(
      manager.connectAll([profileWithServers([{ name: "den" }, { name: "test-runner" }])]),
    ).resolves.toBeUndefined();
    const surface = manager.surfaceForProfile(profileWithServers([{ name: "den" }, { name: "test-runner" }]));
    expect(surface.registry.listNames()).toEqual([]);
    expect(surface.collisions).toEqual([{ toolName: "same", serverNames: ["den", "test-runner"] }]);
  });

  it("keeps optional MCP server failures explicit without dropping required server tools", async () => {
    const clients = [
      new ScriptedMcpClient([[tool("get_task")]]),
      new FailingMcpClient("lab offline"),
    ];
    let index = 0;
    const manager = new DefaultMcpSurfaceManager({
      config: multiConfig(),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      clientFactory: () => clients[index++] as unknown as MCPClient,
    });
    const optionalProfile = profileWithServers([
      { name: "den" },
      { name: "test-runner", optional: true },
    ]);

    const surface = manager.surfaceForProfile(optionalProfile);
    await manager.connectAll([optionalProfile]);

    expect(surface.registry.listNames()).toEqual(["get_task"]);
    expect(surface.servers[1]).toMatchObject({
      name: "test-runner",
      optional: true,
      error: "lab offline",
      discoveredToolNames: [],
    });
  });

  it("throws when a profile selects an unknown MCP server", () => {
    const manager = new DefaultMcpSurfaceManager({
      config: multiConfig(),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
    });

    expect(() => manager.surfaceForProfile(profileWithServers([{ name: "missing" }]))).toThrow(ConfigurationError);
  });
});

class ScriptedMcpClient {
  readonly #scripts: readonly (readonly AgentTool[])[];
  readonly configs: ServerConfig[] = [];
  #connectCount = 0;

  constructor(scripts: readonly (readonly AgentTool[])[]) {
    this.#scripts = scripts;
  }

  connect(config: ServerConfig): Promise<AgentTool[]> {
    this.configs.push(config);
    const index = Math.min(this.#connectCount, this.#scripts.length - 1);
    this.#connectCount += 1;
    return Promise.resolve([...(this.#scripts[index] ?? [])]);
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }
}

class FailingMcpClient {
  constructor(private readonly message: string) {}

  connect(config: ServerConfig): Promise<AgentTool[]> {
    void config;
    return Promise.reject(new Error(this.message));
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
    defaultServer: "den",
    servers: {},
  };
}

function multiConfig() {
  return {
    ...config(),
    defaultServer: "den",
    servers: {
      den: { ...config(), optional: false },
      "test-runner": {
        transport: "streamable-http" as const,
        endpoint: "http://runner/mcp",
        requestTimeout: 120_000,
        maxReconnectAttempts: 1,
        reconnectBaseDelay: 1,
        optional: false,
      },
    },
  };
}

function profileWithServers(servers: NonNullable<Profile["mcpConfig"]>["servers"]): Profile {
  return {
    ...profile,
    mcpConfig: { servers },
  };
}

function tool(name: string): AgentTool {
  return { name, description: `${name} description`, inputSchema: { type: "object" } };
}
