/** Tests for Agent-backed conversational responder boundary. */

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
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

  constructor(private readonly responseText: string) {}

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    this.#listeners.push(listener);
    return () => undefined;
  }

  async prompt(messages: AgentMessage[]): Promise<void> {
    this.prompts.push(messages);
    const assistantMessage: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: this.responseText }],
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
    this.state.messages = [...messages, assistantMessage];
    await this.emit({ type: "agent_start" }, { type: "turn_start" }, {
      type: "message_end",
      message: assistantMessage,
    }, {
      type: "turn_end",
      message: assistantMessage,
      toolResults: [],
    }, {
      type: "agent_end",
      messages: this.state.messages,
    });
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
}

class CapturingConversationalAgentFactory implements ConversationalAgentFactory {
  readonly agent: FakeConversationalAgent;
  readonly created: ConversationalAgentFactoryInput[] = [];

  constructor(responseText: string) {
    this.agent = new FakeConversationalAgent(responseText);
  }

  create(input: ConversationalAgentFactoryInput): ConversationalAgentAdapter {
    this.created.push(input);
    return this.agent;
  }
}

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
    });
    const instance = new AgentInstanceImpl("system-architect", responder, "inst-conv-1");

    const response = await instance.processMessage(createTextMessage("hello"));

    expect(response).toEqual({ kind: "text", text: "model says hello" });
    expect(factory.created).toEqual([
      {
        profileId: "system-architect",
        instanceId: "inst-conv-1",
        systemPrompt: "You are a conversational pi-crew agent.",
      },
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

  it("emits typed conversation turn lifecycle events without worker correlation", async () => {
    const bus = new FakeEventBus();
    const responder = new ConversationalAgentResponder({
      agentFactory: new CapturingConversationalAgentFactory("ok"),
      eventBus: bus,
      logger: new FakeLogger(),
      systemPrompt: "System prompt",
    });

    await responder.respond({
      profileId: "system-architect",
      instanceId: "inst-conv-2",
      message: createTextMessage("status?"),
    });

    expect(bus.emitted.map((event) => event.event)).toEqual([
      "turn.started",
      "turn.completed",
    ]);
    expect(bus.emitted[0]?.payload).toEqual({
      profileId: "system-architect",
      sessionId: "inst-conv-2",
      turnNumber: 1,
    });
    expect(bus.emitted[1]?.payload).toEqual(
      expect.objectContaining({
        profileId: "system-architect",
        sessionId: "inst-conv-2",
        turnNumber: 1,
      }),
    );
    expect(bus.emitted.some((event) => event.event === "completion.posted")).toBe(false);
  });
});
