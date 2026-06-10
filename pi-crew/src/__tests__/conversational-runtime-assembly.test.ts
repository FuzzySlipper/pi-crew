import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { ToolRegistry, type AgentTool as McpAgentTool, type MCPClient } from "@pi-crew/mcp";

import { CrewConfigSchema } from "../config.js";
import {
  buildConversationalAgentResponderFactory,
  resolveConversationalAgentRuntime,
} from "../conversational-runtime-assembly.js";

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

describe("conversational agent config schema", () => {
  it("parses top-level conversationalAgents without treating them as worker pool groups", () => {
    const parsed = CrewConfigSchema.parse({
      den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
      conversationalAgents: [
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

    expect(parsed.conversationalAgents).toHaveLength(1);
    expect(parsed.workerPool.groups).toEqual([]);
  });
  it("fails closed when enabled agent runtime omits explicit tool policy", () => {
    const result = CrewConfigSchema.safeParse({
      den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
      conversationalAgents: [
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

    expect(result.success).toBe(false);
  });
});

describe("resolveConversationalAgentRuntime", () => {
  it("loads inherited profile config, assembles soul prompt, model config, and selected tools", () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-profiles-"));
    writeProfile(
      profilesRoot,
      "base-profile",
      [
        'name: "Base Conversational"',
        'description: "Base profile"',
        "modelConfig:",
        '  provider: "openai"',
        '  model: "gpt-4.1-mini"',
        "  temperature: 0.2",
        "toolPolicy:",
        "  mode: allow_list",
        "  allow:",
        "    - den",
        "",
      ].join("\n"),
      "Base soul prompt.",
    );
    writeProfile(
      profilesRoot,
      "child-profile",
      [
        "extends: base-profile",
        'name: "Child Conversational"',
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
      mcpTool("mcp_den_delete_document"),
      mcpTool("mcp_web_search"),
    ]);

    const runtime = resolveConversationalAgentRuntime({
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
      toolRegistry: registry,
      mcpClient: makeClient(),
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
      resolveConversationalAgentRuntime({
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
        toolRegistry: registry,
        mcpClient: makeClient(),
        logger: new FakeLogger(),
        env: {},
      }),
    ).toThrow(/requires a resolved runtime provider and model/);
  });
});

describe("buildConversationalAgentResponderFactory", () => {
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
    const factory = buildConversationalAgentResponderFactory({
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
      toolRegistry: registry,
      mcpClient: makeClient(),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      env: {},
    });

    expect(factory.createResponder({ profileId: "runner-profile" })).toBeDefined();
  });
});
