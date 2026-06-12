import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger, ok, type ChannelMessage } from "@pi-crew/core";
import { ToolRegistry, type MCPClient } from "@pi-crew/mcp";
import type {
  ConversationalAgentAdapter,
  ConversationalAgentFactory,
  ConversationalAgentFactoryInput,
  DelegatedSpawnInput,
  DelegatedSpawnLifecyclePort,
} from "@pi-crew/service";
import { CrewConfigSchema } from "../config.js";
import { buildConversationalAgentResponderFactoryForAgents } from "../conversational-runtime-assembly.js";

class DelegatingAgent implements ConversationalAgentAdapter {
  readonly #signal = new AbortController().signal;
  readonly state = { messages: [] as AgentMessage[] };
  constructor(private readonly tools: readonly AgentTool[]) {}
  subscribe(_listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
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

class CapturingAgentFactory implements ConversationalAgentFactory {
  readonly inputs: ConversationalAgentFactoryInput[] = [];
  create(input: ConversationalAgentFactoryInput): ConversationalAgentAdapter {
    this.inputs.push(input);
    return new DelegatingAgent(input.tools ?? []);
  }
}

class CapturingLifecycle implements DelegatedSpawnLifecyclePort {
  inputs: DelegatedSpawnInput[] = [];
  spawn(input: DelegatedSpawnInput) {
    this.inputs.push(input);
    return Promise.resolve(ok({
      outcome: "success" as const,
      summary: "child completed",
      policyId: input.parentPolicy.policyId,
      childSessionId: "child-session-1",
      effectiveRuntime: input.parentRuntime,
    }));
  }
}

describe("conversational delegation wiring", () => {
  it("adds spawn_subagent to configured conversational agents and reaches the lifecycle", async () => {
    const profilesRoot = mkdtempSync(join(tmpdir(), "pi-crew-conv-delegation-"));
    writeProfile(profilesRoot, "runner-profile");
    const agent = CrewConfigSchema.parse({
      den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
      conversationalAgents: [{
        agentId: "runner",
        enabled: true,
        profileId: "runner-profile",
        profileIdentity: "runner",
        memberIdentity: "runner",
        session: { ownerId: "owner", sessionId: "configured-session", maxHistoryMessages: 20 },
        channels: [{ providerId: "den-channels", channelId: "642", subscriptionIdentity: "runner:ordinary" }],
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
      }],
    }).conversationalAgents;
    const lifecycle = new CapturingLifecycle();
    const agentFactory = new CapturingAgentFactory();
    const factory = buildConversationalAgentResponderFactoryForAgents({
      agents: agent,
      profilesRoot,
      toolRegistry: new ToolRegistry(new FakeLogger()),
      mcpClient: { callTool: () => Promise.resolve({ ok: true, content: [] }) } as unknown as MCPClient,
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      agentFactory,
      delegation: { lifecycle, parentDelegationConstraints: { maxSpawnDepth: 2 } },
    });

    const responder = factory.createResponder({
      profileId: "runner-profile",
      sessionId: "live-parent-session",
      kind: "conversational",
    });
    await responder.respond({
      profileId: "runner-profile",
      sessionId: "live-parent-session",
      instanceId: "instance-1",
      message: textMessage("delegate this"),
    });

    expect(agentFactory.inputs[0]?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["spawn_subagent", "fan_out_subagents"]),
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
});

function writeProfile(root: string, profileId: string): void {
  const dir = join(root, profileId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "soul.md"), "Runner soul.", "utf-8");
  writeFileSync(join(dir, "profile.yaml"), [
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
    "",
  ].join("\n"), "utf-8");
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
