/** Tests for Agent-backed conversational responder boundary. */

import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ChannelMessage } from "@pi-crew/core";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { describe, expect, it } from "vitest";
import { AgentInstanceImpl } from "../../instances/agent-instance.js";
import {
  ConversationalAgentResponder,
  type ConversationalAgentAdapter,
  type ConversationalAgentFactory,
  type ConversationalAgentFactoryInput,
} from "../../instances/conversational-agent-responder.js";

class FakeConversationalAgent implements ConversationalAgentAdapter {
  readonly prompts: AgentMessage[][] = [];
  readonly #listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
  readonly #signal = new AbortController().signal;
  readonly state = { messages: [] as AgentMessage[] };
  aborted = false;

  constructor(
    private readonly response: string | AssistantMessage,
    private readonly emitFullLifecycle = false,
  ) {}

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    this.#listeners.push(listener);
    return () => undefined;
  }

  async prompt(messages: AgentMessage[]): Promise<void> {
    this.prompts.push(messages);
    const assistantMessage =
      typeof this.response === "string" ? createAssistantMessage(this.response) : this.response;
    this.state.messages = [...messages, assistantMessage];
    await this.emit(...this.lifecycleEvents(assistantMessage));
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  abort(): void {
    this.aborted = true;
  }

  private async emit(...events: AgentEvent[]): Promise<void> {
    for (const event of events) {
      for (const listener of this.#listeners) {
        await listener(event, this.#signal);
      }
    }
  }

  private lifecycleEvents(assistantMessage: AssistantMessage): AgentEvent[] {
    const events: AgentEvent[] = [{ type: "agent_start" }, { type: "turn_start" }];
    if (this.emitFullLifecycle) {
      events.push(
        { type: "message_start", message: assistantMessage },
        {
          type: "message_update",
          message: assistantMessage,
          assistantMessageEvent: { type: "start", partial: assistantMessage },
        },
        {
          type: "tool_execution_start",
          toolCallId: "tool-call-1",
          toolName: "lookup_status",
          args: { channelId: "channel-1" },
        },
        {
          type: "tool_execution_update",
          toolCallId: "tool-call-1",
          toolName: "lookup_status",
          args: { channelId: "channel-1" },
          partialResult: { content: "working" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "tool-call-1",
          toolName: "lookup_status",
          result: { content: "done" },
          isError: false,
        },
      );
    }
    events.push(
      {
        type: "message_end",
        message: assistantMessage,
      },
      {
        type: "turn_end",
        message: assistantMessage,
        toolResults: [],
      },
      {
        type: "agent_end",
        messages: this.state.messages,
      },
    );
    return events;
  }
}

class CapturingConversationalAgentFactory implements ConversationalAgentFactory {
  readonly agent: FakeConversationalAgent;
  readonly created: ConversationalAgentFactoryInput[] = [];

  constructor(response: string | AssistantMessage, emitFullLifecycle = false) {
    this.agent = new FakeConversationalAgent(response, emitFullLifecycle);
  }

  create(input: ConversationalAgentFactoryInput): ConversationalAgentAdapter {
    this.created.push(input);
    return this.agent;
  }
}

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.parse("2026-06-10T00:00:00.000Z"),
  };
}

type ErrorAssistantMessage = AssistantMessage & {
  readonly errorMessage: string;
  readonly stopReason: "error";
};

function createErrorAssistantMessage(errorMessage: string): ErrorAssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: Date.parse("2026-06-10T00:00:00.000Z"),
    errorMessage,
  };
}

const runtimeModel: Model<Api> = {
  id: "gpt-test",
  name: "gpt-test",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "http://model.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 2048,
};

const runtimeTool: AgentTool = {
  label: "lookup_status",
  name: "lookup_status",
  description: "Lookup status",
  parameters: Type.Object({}),
  execute: () =>
    Promise.resolve({ content: [{ type: "text", text: "ok" }], details: { ok: true } }),
};

function createTextMessage(text: string): ChannelMessage {
  return {
    id: "message-1",
    channelId: "channel-1",
    sender: {
      id: "human-1",
      displayName: "Human One",
      kind: "human",
      platform: "test",
    },
    content: { kind: "text", text },
    timestamp: new Date("2026-06-10T00:00:00.000Z"),
  };
}

describe("ConversationalAgentResponder", () => {
  it("runs an Agent-backed conversational turn and returns assistant text", async () => {
    const factory = new CapturingConversationalAgentFactory("model says hello");
    const responder = new ConversationalAgentResponder({
      agentFactory: factory,
      eventBus: new FakeEventBus(),
      logger: new FakeLogger(),
      systemPrompt: "You are a conversational pi-crew agent.",
      model: runtimeModel,
      apiKey: "runtime-key",
      temperature: 0.4,
      maxTokens: 2048,
      tools: [runtimeTool],
    });
    const instance = new AgentInstanceImpl("system-architect", responder, "inst-conv-1");

    const response = await instance.processMessage(createTextMessage("hello"));

    expect(response).toEqual({ kind: "text", text: "model says hello" });
    expect(factory.created).toEqual([
      expect.objectContaining({
        sessionId: "inst-conv-1",
        profileId: "system-architect",
        instanceId: "inst-conv-1",
        systemPrompt: "You are a conversational pi-crew agent.",
        model: runtimeModel,
        apiKey: "runtime-key",
        temperature: 0.4,
        maxTokens: 2048,
        tools: [runtimeTool],
      }),
    ]);
    expect(factory.agent.prompts).toEqual([
      [
        {
          role: "user",
          content: "hello",
          timestamp: Date.parse("2026-06-10T00:00:00.000Z"),
        },
      ],
    ]);
  });

  it("returns model errors as visible channel text instead of blank messages", async () => {
    const factory = new CapturingConversationalAgentFactory(
      createErrorAssistantMessage("402 insufficient credits"),
    );
    const responder = new ConversationalAgentResponder({
      agentFactory: factory,
      eventBus: new FakeEventBus(),
      logger: new FakeLogger(),
      systemPrompt: "System prompt",
    });

    const response = await responder.respond({
      sessionId: "sess-conv-error",
      profileId: "pi-orchestrator",
      instanceId: "inst-conv-error",
      message: createTextMessage("ping"),
    });

    expect(response).toEqual({
      kind: "text",
      text: "pi-orchestrator model call failed: 402 insufficient credits",
    });
  });

  it("emits typed conversation turn lifecycle events without worker correlation", async () => {
    const bus = new FakeEventBus();
    const responder = new ConversationalAgentResponder({
      agentFactory: new CapturingConversationalAgentFactory("ok"),
      eventBus: bus,
      logger: new FakeLogger(),
      systemPrompt: "System prompt",
    });

    await responder.respond({
      sessionId: "sess-conv-2",
      profileId: "system-architect",
      instanceId: "inst-conv-2",
      message: createTextMessage("status?"),
    });

    expect(bus.emitted.map((event) => event.event)).toEqual([
      "turn.started",
      "message.completed",
      "turn.completed",
    ]);
    expect(bus.emitted[0]?.payload).toEqual({
      profileId: "system-architect",
      sessionId: "sess-conv-2",
      turnNumber: 1,
    });
    expect(bus.emitted[2]?.payload).toEqual(
      expect.objectContaining({
        profileId: "system-architect",
        sessionId: "sess-conv-2",
        turnNumber: 1,
      }),
    );
    expect(bus.emitted.some((event) => event.event === "completion.posted")).toBe(false);
  });

  it("bridges Agent message and tool lifecycle events without worker completion semantics", async () => {
    const bus = new FakeEventBus();
    const responder = new ConversationalAgentResponder({
      agentFactory: new CapturingConversationalAgentFactory("ok", true),
      eventBus: bus,
      logger: new FakeLogger(),
      systemPrompt: "System prompt",
    });

    await responder.respond({
      sessionId: "sess-conv-2",
      profileId: "system-architect",
      instanceId: "inst-conv-3",
      message: createTextMessage("use a tool"),
    });

    expect(bus.emitted.map((event) => event.event)).toEqual([
      "turn.started",
      "message.started",
      "message.updated",
      "tool.called",
      "tool.completed",
      "tool.completed",
      "message.completed",
      "turn.completed",
    ]);
    expect(bus.emitted[1]?.payload).toEqual({
      profileId: "system-architect",
      sessionId: "sess-conv-2",
      messageRole: "assistant",
    });
    expect(bus.emitted[2]?.payload).toEqual({
      profileId: "system-architect",
      sessionId: "sess-conv-2",
      messageRole: "assistant",
      updateType: "start",
    });
    expect(bus.emitted[3]?.payload).toEqual({
      profileId: "system-architect",
      sessionId: "sess-conv-2",
      toolName: "lookup_status",
      params: { channelId: "channel-1" },
    });
    expect(bus.emitted[4]?.payload).toEqual({
      profileId: "system-architect",
      sessionId: "sess-conv-2",
      toolName: "lookup_status",
      success: true,
      durationMs: 0,
      result: { content: "working" },
    });
    expect(bus.emitted[5]?.payload).toEqual({
      profileId: "system-architect",
      sessionId: "sess-conv-2",
      toolName: "lookup_status",
      success: true,
      durationMs: 0,
      result: { content: "done" },
    });
    expect(bus.emitted[6]?.payload).toEqual({
      profileId: "system-architect",
      sessionId: "sess-conv-2",
      messageRole: "assistant",
    });
    expect(bus.emitted.some((event) => event.event === "completion.posted")).toBe(false);
  });
});
