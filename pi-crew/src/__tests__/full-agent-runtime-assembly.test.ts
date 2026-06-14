import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { ToolRegistry, type AgentTool as McpAgentTool, type MCPClient } from "@pi-crew/mcp";
import type { Profile } from "@pi-crew/profiles";
import type { McpSurface, McpSurfaceManager } from "../mcp-surface-manager.js";

import { CrewConfigSchema } from "../config.js";
import {
  buildFullAgentResponderFactory, buildFullAgentResponderFactoryForAgents, resolveFullAgentRuntime,
} from "../full-agent-runtime-assembly.js";

function writeProfile(
  root: string,
  profileId: string,
  yaml: string,
  soul = `${profileId} soul.`,
): void {
  const dir = join(root, profileId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.yaml"), yaml, "utf-8");
  writeFileSync(join(dir, "soul.md"), soul, "utf-8");
}

function mcpTool(name: string): McpAgentTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
  };
}

function makeClient(): MCPClient {
  return {
    callTool: () => Promise.resolve({ ok: true, content: [{ type: "text", text: "ok" }] }),
  } as unknown as MCPClient;
}

function surfaceManager(registry: ToolRegistry, client = makeClient()): McpSurfaceManager {
  return {
    surfaceForProfile: (profile: Profile): McpSurface => ({ endpoint: `http://mcp.test/${profile.mcpConfig?.toolProfile ?? "default"}`, toolProfile: profile.mcpConfig?.toolProfile, client, registry }),
    connectAll: () => Promise.resolve(),
    disconnectAll: () => Promise.resolve(),
  };
}

type FullAgentConfig = ReturnType<typeof CrewConfigSchema.parse>["fullAgents"][number];

function parsedAgent(profileId: string, runtime: Record<string, unknown>): FullAgentConfig {
  return CrewConfigSchema.parse({
    den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
    fullAgents: [{
      agentId: `agent-${profileId}`,
      enabled: true,
      profileId,
      profileIdentity: profileId,
      memberIdentity: profileId,
      session: { ownerId: "owner", sessionId: `sess-${profileId}`, maxHistoryMessages: 20 },
      channels: [{ providerId: "den-channels", channelId: "642", subscriptionIdentity: `${profileId}:ordinary` }],
      runtime,
      lifecycle: { turnTimeoutMs: 300000 },
    }],
  }).fullAgents[0] as FullAgentConfig;
}

describe("full agent config schema", () => {
  it("parses top-level fullAgents without treating them as worker pool groups", () => {
    const parsed = CrewConfigSchema.parse({
      den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
      fullAgents: [
        {
          agentId: "pi-crew-runner",
          enabled: true,
          profileId: "child-profile",
          profileIdentity: "pi-crew-runner",
          memberIdentity: "pi-crew-runner",
          memberRole: "runner",
          displayName: "Pi Crew Runner",
          session: {
            ownerId: "owner:den-k8plus:pi-crew-runner",
            sessionId: "sess-pi-crew-runner-installed-service",
            idleTimeoutMs: 28800000,
            maxHistoryMessages: 200,
          },
          channels: [
            {
              providerId: "den-channels",
              channelId: "642",
              subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-installed-service",
              wakePolicy: "subscription",
            },
          ],
          runtime: {
            mode: "agent",
            provider: "openai",
            model: "gpt-4.1-mini",
            systemPromptSource: "profile",
            tools: { allow: ["den"] },
            toolPolicy: { mode: "profile" },
          },
          lifecycle: {
            singleFlight: true,
            turnTimeoutMs: 300000,
            onStartup: "rehydrate_or_create",
            onShutdownStatus: "offline",
          },
        },
      ],
      workerPool: { groups: [] },
    });

    expect(parsed.fullAgents).toHaveLength(1);
    expect(parsed.workerPool.groups).toEqual([]);
  });
  it("allows conversation agent runtime config to be profile-owned", () => {
    const result = CrewConfigSchema.safeParse({
      den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
      fullAgents: [
        {
          agentId: "pi-crew-runner",
          enabled: true,
          profileId: "child-profile",
          profileIdentity: "pi-crew-runner",
          memberIdentity: "pi-crew-runner",
          session: {
            ownerId: "owner:den-k8plus:pi-crew-runner",
            sessionId: "sess-pi-crew-runner-installed-service",
            maxHistoryMessages: 200,
          },
          channels: [
            {
              providerId: "den-channels",
              channelId: "642",
              subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-installed-service",
            },
          ],
          runtime: {
            mode: "agent",
            provider: "openai",
            model: "gpt-4.1-mini",
            systemPromptSource: "profile",
            tools: { allow: ["den"] },
          },
          lifecycle: { turnTimeoutMs: 300000 },
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe("resolveFullAgentRuntime", () => {
  it("loads inherited profile config, assembles soul prompt, model config, and selected tools", () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-profiles-"));
    writeProfile(
      profilesRoot,
      "base-profile",
      [
        'name: "Base FullAgent"',
        'description: "Base profile"',
        "modelConfig:",
        '  provider: "openai"',
        '  model: "gpt-4.1-mini"',
        "  temperature: 0.2",
        "toolPolicy:",
        "  mode: allow_list",
        "  allow:",
        "    - mcp_den_get_task",
        "",
      ].join("\n"),
      "Base soul prompt.",
    );
    writeProfile(
      profilesRoot,
      "child-profile",
      [
        "extends: base-profile",
        'name: "Child FullAgent"',
        'description: "Child profile"',
        "modelConfig:",
        "  temperature: 0.4",
        "",
      ].join("\n"),
      "Child soul prompt.",
    );
    const registry = new ToolRegistry(new FakeLogger());
    registry.setMcpTools([
      mcpTool("mcp_den_get_task"),
      mcpTool("mcp_den_get_messages"),
      mcpTool("mcp_den_delete_document"),
      mcpTool("mcp_web_search"),
    ]);

    const runtime = resolveFullAgentRuntime({
      agent: {
        agentId: "pi-crew-runner",
        enabled: true,
        profileId: "child-profile",
        profileIdentity: "pi-crew-runner",
        memberIdentity: "pi-crew-runner",
        session: {
          ownerId: "owner:den-k8plus:pi-crew-runner",
          sessionId: "sess-pi-crew-runner-installed-service",
          maxHistoryMessages: 200,
        },
        channels: [
          {
            providerId: "den-channels",
            channelId: "642",
            subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-installed-service",
            wakePolicy: "subscription",
          },
        ],
        runtime: {
          mode: "agent",
          systemPromptSource: "profile",
          tools: { allow: ["den"] },
          toolPolicy: { mode: "profile" },
        },
        lifecycle: {
          singleFlight: true,
          turnTimeoutMs: 300000,
          onStartup: "rehydrate_or_create",
          onShutdownStatus: "offline",
        },
      },
      profilesRoot,
      mcpSurfaceManager: surfaceManager(registry),
      logger: new FakeLogger(),
      env: {},
    });

    expect(runtime.profile.id).toBe("child-profile");
    expect(runtime.model.provider).toBe("openai");
    expect(runtime.model.modelName).toBe("gpt-4.1-mini");
    expect(runtime.model.temperature).toBe(0.4);
    expect(runtime.systemPrompt).toContain("Base soul prompt.");
    expect(runtime.systemPrompt).toContain("Child soul prompt.");
    expect(runtime.systemPrompt).toContain("Inherited prompt: base-profile");
    expect(runtime.tools.map((tool) => tool.name)).toEqual(["mcp_den_get_task"]);
  });

  it("applies profile deny-list after runtime tool selection", () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-deny-tools-"));
    writeProfile(
      profilesRoot,
      "deny-profile",
      [
        'name: "Deny Profile"',
        'description: "Deny profile"',
        "modelConfig:",
        '  provider: "openai"',
        '  model: "gpt-4.1-mini"',
        "toolPolicy:",
        "  mode: deny_list",
        "  deny:",
        "    - mcp_den_get_messages",
        "",
      ].join("\n"),
      "Deny soul.",
    );
    const registry = new ToolRegistry(new FakeLogger());
    registry.setMcpTools([mcpTool("mcp_den_get_task"), mcpTool("mcp_den_get_messages")]);

    const runtime = resolveFullAgentRuntime({
      agent: {
        agentId: "pi-crew-runner",
        enabled: true,
        profileId: "deny-profile",
        profileIdentity: "pi-crew-runner",
        memberIdentity: "pi-crew-runner",
        session: {
          ownerId: "owner:den-k8plus:pi-crew-runner",
          sessionId: "sess-pi-crew-runner-installed-service",
          maxHistoryMessages: 200,
        },
        channels: [
          {
            providerId: "den-channels",
            channelId: "642",
            subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-installed-service",
            wakePolicy: "subscription",
          },
        ],
        runtime: {
          mode: "agent",
          systemPromptSource: "profile",
          tools: { allow: ["den"] },
          toolPolicy: { mode: "profile" },
        },
        lifecycle: {
          singleFlight: true,
          turnTimeoutMs: 300000,
          onStartup: "rehydrate_or_create",
          onShutdownStatus: "offline",
        },
      },
      profilesRoot,
      mcpSurfaceManager: surfaceManager(registry),
      logger: new FakeLogger(),
      env: {},
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["mcp_den_get_task"]);
  });

  it("fails closed when provider/model are not registered and no OpenAI-compatible baseUrl is configured", () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-invalid-provider-"));
    writeProfile(
      profilesRoot,
      "invalid-provider",
      [
        'name: "Invalid Provider"',
        'description: "Invalid"',
        "toolPolicy:",
        "  mode: allow_all",
        "",
      ].join("\n"),
      "Invalid provider soul.",
    );
    const registry = new ToolRegistry(new FakeLogger());

    expect(() =>
      resolveFullAgentRuntime({
        agent: parsedAgent("invalid-provider", {
          mode: "agent",
          provider: "not-a-provider",
          model: "not-a-model",
          systemPromptSource: "profile",
          tools: { allow: [] },
          toolPolicy: { mode: "profile" },
        }),
        profilesRoot,
        mcpSurfaceManager: surfaceManager(registry),
        logger: new FakeLogger(),
        env: {},
      }),
    ).toThrow(/not registered and has no OpenAI-compatible baseUrl/);
  });

  it("fails closed when an enabled agent has no resolved provider or model", () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-missing-model-"));
    writeProfile(
      profilesRoot,
      "missing-model",
      'name: "Missing Model"\ndescription: "No model config"\n',
      "Missing model soul.",
    );
    const registry = new ToolRegistry(new FakeLogger());

    expect(() =>
      resolveFullAgentRuntime({
        agent: {
          agentId: "pi-crew-runner",
          enabled: true,
          profileId: "missing-model",
          profileIdentity: "pi-crew-runner",
          memberIdentity: "pi-crew-runner",
          session: {
            ownerId: "owner:den-k8plus:pi-crew-runner",
            sessionId: "sess-pi-crew-runner-installed-service",
            maxHistoryMessages: 200,
          },
          channels: [
            {
              providerId: "den-channels",
              channelId: "642",
              subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-installed-service",
              wakePolicy: "subscription",
            },
          ],
          runtime: {
            mode: "agent",
            systemPromptSource: "profile",
            tools: { allow: [] },
            toolPolicy: { mode: "profile" },
          },
          lifecycle: {
            singleFlight: true,
            turnTimeoutMs: 300000,
            onStartup: "rehydrate_or_create",
            onShutdownStatus: "offline",
          },
        },
        profilesRoot,
        mcpSurfaceManager: surfaceManager(registry),
        logger: new FakeLogger(),
        env: {},
      }),
    ).toThrow(/requires a resolved runtime provider and model/);
  });
});

describe("buildFullAgentResponderFactory", () => {
  it("fails closed when a single configured full agent receives another profileId", () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-profile-mismatch-"));
    writeProfile(
      profilesRoot,
      "runner-profile",
      [
        'name: "Runner Profile"',
        'description: "Runner"',
        "modelConfig:",
        '  provider: "openai"',
        '  model: "gpt-4.1-mini"',
        "toolPolicy:",
        "  mode: allow_all",
        "",
      ].join("\n"),
      "Runner soul.",
    );
    const factory = buildFullAgentResponderFactoryForAgents({
      agents: [
        parsedAgent("runner-profile", {
          mode: "agent",
          systemPromptSource: "profile",
          tools: { allow: [] },
          toolPolicy: { mode: "profile" },
        }),
      ],
      profilesRoot,
      mcpSurfaceManager: surfaceManager(new ToolRegistry(new FakeLogger())),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      env: {},
    });

    expect(() => factory.createResponder({ profileId: "other-profile" })).toThrow(
      /No configured full agent matches profile other-profile/,
    );
  });

  it("creates an Agent-backed responder factory for configured agent mode", () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-factory-"));
    writeProfile(
      profilesRoot,
      "runner-profile",
      [
        'name: "Runner Profile"',
        'description: "Runner"',
        "modelConfig:",
        '  provider: "openai"',
        '  model: "gpt-4.1-mini"',
        "toolPolicy:",
        "  mode: allow_list",
        "  allow:",
        "    - den",
        "",
      ].join("\n"),
      "Runner soul.",
    );
    const registry = new ToolRegistry(new FakeLogger());
    const factory = buildFullAgentResponderFactory({
      agent: {
        agentId: "pi-crew-runner",
        enabled: true,
        profileId: "runner-profile",
        profileIdentity: "pi-crew-runner",
        memberIdentity: "pi-crew-runner",
        session: {
          ownerId: "owner:den-k8plus:pi-crew-runner",
          sessionId: "sess-pi-crew-runner-installed-service",
          maxHistoryMessages: 200,
        },
        channels: [
          {
            providerId: "den-channels",
            channelId: "642",
            subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-installed-service",
            wakePolicy: "subscription",
          },
        ],
        runtime: {
          mode: "agent",
          provider: "openai",
          model: "gpt-4.1-mini",
          systemPromptSource: "profile",
          tools: { allow: [] },
          toolPolicy: { mode: "profile" },
        },
        lifecycle: {
          singleFlight: true,
          turnTimeoutMs: 300000,
          onStartup: "rehydrate_or_create",
          onShutdownStatus: "offline",
        },
      },
      profilesRoot,
      mcpSurfaceManager: surfaceManager(registry),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      env: {},
    });

    expect(factory.createResponder({ profileId: "runner-profile" })).toBeDefined();
  });
});
