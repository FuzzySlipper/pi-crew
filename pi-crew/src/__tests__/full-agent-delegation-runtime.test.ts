import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger, ok, type ChannelMessage } from "@pi-crew/core";
import { ToolRegistry, type MCPClient } from "@pi-crew/mcp";
import type { Profile } from "@pi-crew/profiles";
import type { McpSurface, McpSurfaceManager } from "../mcp-surface-manager.js";
import type {
  FullAgentAdapter,
  FullAgentFactory,
  FullAgentFactoryInput,
  DelegatedSpawnInput,
  DelegatedSpawnLifecyclePort,
} from "@pi-crew/service";
import { CrewConfigSchema } from "../config.js";
import { buildFullAgentResponderFactoryForAgents } from "../full-agent-runtime-assembly.js";

class DelegatingAgent implements FullAgentAdapter {
  readonly #signal = new AbortController().signal;
  readonly state = { messages: [] as AgentMessage[] };
  constructor(private readonly tools: readonly AgentTool[]) {}
  subscribe(
    _listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    return () => undefined;
  }
  async prompt(messages: AgentMessage[]): Promise<void> {
    const tool = this.tools.find((candidate) => candidate.name === "spawn_subagent");
    await tool?.execute("call-1", { task: "inspect the delegation path" }, this.#signal);
    this.state.messages = [...messages, assistantMessage("delegation requested")];
  }
  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }
  abort(): void {}
}

class ReadbackAgent implements FullAgentAdapter {
  readonly #signal = new AbortController().signal;
  readonly state = { messages: [] as AgentMessage[] };
  constructor(private readonly tools: readonly AgentTool[]) {}
  subscribe(
    _listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    return () => undefined;
  }
  async prompt(messages: AgentMessage[]): Promise<void> {
    const tool = this.tools.find((candidate) => candidate.name === "den_channels_read_recent");
    const result = await tool?.execute("read-1", { channelId: "642", limit: 20 }, this.#signal);
    const text = result?.content[0]?.text ?? "missing readback";
    this.state.messages = [...messages, assistantMessage(text)];
  }
  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }
  abort(): void {}
}

class CapturingAgentFactory implements FullAgentFactory {
  readonly inputs: FullAgentFactoryInput[] = [];
  constructor(private readonly mode: "delegation" | "readback" = "delegation") {}
  create(input: FullAgentFactoryInput): FullAgentAdapter {
    this.inputs.push(input);
    return this.mode === "delegation"
      ? new DelegatingAgent(input.tools ?? [])
      : new ReadbackAgent(input.tools ?? []);
  }
}

class CapturingLifecycle implements DelegatedSpawnLifecyclePort {
  inputs: DelegatedSpawnInput[] = [];
  spawn(input: DelegatedSpawnInput) {
    this.inputs.push(input);
    return Promise.resolve(
      ok({
        outcome: "success" as const,
        summary: "child completed",
        policyId: input.parentPolicy.policyId,
        childSessionId: "child-session-1",
        effectiveRuntime: input.parentRuntime,
      }),
    );
  }
}

function surfaceManager(registry: ToolRegistry): McpSurfaceManager {
  const client = { callTool: () => Promise.resolve({ ok: true, content: [] }) } as unknown as MCPClient;
  return {
    surfaceForProfile: (profile: Profile): McpSurface => ({ endpoint: "http://mcp.test", toolProfile: profile.mcpConfig?.toolProfile, client, registry }),
    connectAll: () => Promise.resolve(),
    disconnectAll: () => Promise.resolve(),
  };
}

describe("fullAgent delegation wiring", () => {
  it("adds spawn_subagent to configured full agents and reaches the lifecycle", async () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-delegation-"));
    writeProfile(profilesRoot, "runner-profile");
    const agent = CrewConfigSchema.parse({
      den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
      fullAgents: [
        {
          agentId: "runner",
          enabled: true,
          profileId: "runner-profile",
          profileIdentity: "runner",
          memberIdentity: "runner",
          session: { ownerId: "owner", sessionId: "configured-session", maxHistoryMessages: 20 },
          channels: [
            {
              providerId: "den-channels",
              channelId: "642",
              subscriptionIdentity: "runner:ordinary",
            },
          ],
          runtime: {
            mode: "agent",
            provider: "local-openai-compatible",
            model: "local-model",
            baseUrl: "http://127.0.0.1:11434/v1",
            systemPromptSource: "profile",
            tools: { allow: ["delegation"] },
            toolPolicy: { mode: "profile" },
          },
          lifecycle: { turnTimeoutMs: 300000 },
        },
      ],
    }).fullAgents;
    const lifecycle = new CapturingLifecycle();
    const agentFactory = new CapturingAgentFactory();
    const factory = buildFullAgentResponderFactoryForAgents({
      agents: agent,
      profilesRoot,
      mcpSurfaceManager: surfaceManager(new ToolRegistry(new FakeLogger())),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      agentFactory,
      delegation: { lifecycle, parentDelegationConstraints: { maxSpawnDepth: 2 } },
    });

    const responder = factory.createResponder({
      profileId: "runner-profile",
      sessionId: "live-parent-session",
      kind: "full",
    });
    await responder.respond({
      profileId: "runner-profile",
      sessionId: "live-parent-session",
      instanceId: "instance-1",
      message: textMessage("delegate this"),
    });

    expect(agentFactory.inputs[0]?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "spawn_subagent",
        "fan_out_subagents",
        "scout_codebase",
        "summarize_files",
        "find_relevant_paths",
      ]),
    );
    expect(lifecycle.inputs).toHaveLength(1);
    expect(lifecycle.inputs[0]?.parentSessionId).toBe("live-parent-session");
    expect(lifecycle.inputs[0]?.parentDelegationConstraints.maxSpawnDepth).toBe(2);
    expect(lifecycle.inputs[0]?.parentRuntime).toEqual({
      profileId: "runner-profile",
      provider: "local-openai-compatible",
      model: "local-model",
    });
  });

  it("adds safe current-channel Den Channels readback for configured full agents", async () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-channel-readback-"));
    writeProfile(profilesRoot, "runner-profile", ["den_channels_read_recent"]);
    const agent = CrewConfigSchema.parse({
      den: {
        coreUrl: "http://localhost:3030",
        channelsUrl: "http://192.168.1.10:18081",
        requiredAtStartup: false,
      },
      fullAgents: [
        {
          agentId: "runner",
          enabled: true,
          profileId: "runner-profile",
          profileIdentity: "runner",
          memberIdentity: "runner",
          session: { ownerId: "owner", sessionId: "configured-session", maxHistoryMessages: 20 },
          channels: [
            {
              providerId: "den-channels",
              channelId: "642",
              subscriptionIdentity: "runner:ordinary",
            },
          ],
          runtime: {
            mode: "agent",
            provider: "local-openai-compatible",
            model: "local-model",
            baseUrl: "http://127.0.0.1:11434/v1",
            systemPromptSource: "profile",
            tools: { allow: ["den"] },
            toolPolicy: { mode: "profile" },
          },
          lifecycle: { turnTimeoutMs: 300000 },
        },
      ],
    }).fullAgents;
    const fetchFn = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            messages: [
              {
                id: 4791,
                body: "**delegation.tool_visible** get_task_workflow_summary toolCallId tool-1",
                createdAt: "2026-06-12T09:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const agentFactory = new CapturingAgentFactory("readback");
    const factory = buildFullAgentResponderFactoryForAgents({
      agents: agent,
      profilesRoot,
      mcpSurfaceManager: surfaceManager(new ToolRegistry(new FakeLogger())),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      agentFactory,
      channelReadback: {
        baseUrl: "http://192.168.1.10:18081",
        fetchFn: fetchFn as unknown as typeof fetch,
      },
    });

    const responder = factory.createResponder({
      profileId: "runner-profile",
      sessionId: "live-parent-session",
      kind: "full",
    });
    const response = await responder.respond({
      profileId: "runner-profile",
      sessionId: "live-parent-session",
      instanceId: "instance-1",
      message: textMessage("verify channel evidence"),
    });

    expect(agentFactory.inputs[0]?.tools?.map((tool) => tool.name)).toContain(
      "den_channels_read_recent",
    );
    expect(response).toMatchObject({
      kind: "text",
      text: expect.stringContaining("message #4791"),
    });
  });
});

function writeProfile(
  root: string,
  profileId: string,
  extraAllowedTools: readonly string[] = [],
): void {
  const dir = join(root, profileId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "soul.md"), "Runner soul.", "utf-8");
  writeFileSync(
    join(dir, "profile.yaml"),
    [
      'name: "Runner"',
      'description: "Runner profile"',
      "modelConfig:",
      '  provider: "local-openai-compatible"',
      '  model: "local-model"',
      '  baseUrl: "http://127.0.0.1:11434/v1"',
      "toolPolicy:",
      "  mode: allow_list",
      "  allow:",
      "    - spawn_subagent",
      "    - fan_out_subagents",
      "    - scout_codebase",
      "    - summarize_files",
      "    - find_relevant_paths",
      ...extraAllowedTools.map((tool) => `    - ${tool}`),
      "",
    ].join("\n"),
    "utf-8",
  );
}

function textMessage(text: string): ChannelMessage {
  return {
    id: "message-1",
    channelId: "channel-1",
    sender: { id: "human-1", displayName: "Human", kind: "human", platform: "test" },
    content: { kind: "text", text },
    timestamp: new Date("2026-06-12T00:00:00.000Z"),
  };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "local-openai-compatible",
    model: "local-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.parse("2026-06-12T00:00:00.000Z"),
  };
}
