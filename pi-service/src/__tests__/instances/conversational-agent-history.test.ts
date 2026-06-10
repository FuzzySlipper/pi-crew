/** Tests for conversational Agent history persistence and rehydration. */

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChannelMessage } from "@pi-crew/core";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { describe, expect, it } from "vitest";
import { AgentInstanceImpl } from "../../instances/agent-instance.js";
import {
  ConversationalAgentResponder,
  type ConversationalAgentAdapter,
  type ConversationalAgentFactory,
  type ConversationalAgentFactoryInput,
  type ConversationalTurnHistory,
} from "../../instances/conversational-agent-responder.js";

class CapturingAgent implements ConversationalAgentAdapter {
  readonly prompts: AgentMessage[][] = [];
  readonly state = { messages: [] as AgentMessage[] };
  readonly #signal = new AbortController().signal;
  readonly #listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    this.#listeners.push(listener);
    return () => undefined;
  }

  async prompt(messages: AgentMessage[]): Promise<void> {
    this.prompts.push(messages);
    const assistant = assistantMessage("fresh assistant response");
    this.state.messages = [...messages, assistant];
    for (const listener of this.#listeners) {
      await listener({ type: "message_end", message: assistant }, this.#signal);
      await listener({ type: "turn_end", message: assistant, toolResults: [] }, this.#signal);
    }
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  abort(): void {
    return undefined;
  }
}

class CapturingAgentFactory implements ConversationalAgentFactory {
  readonly agent = new CapturingAgent();
  readonly created: ConversationalAgentFactoryInput[] = [];

  create(input: ConversationalAgentFactoryInput): ConversationalAgentAdapter {
    this.created.push(input);
    return this.agent;
  }
}

class InMemoryTurnHistory implements ConversationalTurnHistory {
  readonly appended: Array<{
    sessionId: string;
    role: AgentMessage["role"];
    message: AgentMessage;
  }> = [];

  constructor(private readonly existing: readonly AgentMessage[]) {}

  loadRecent(sessionId: string, limit: number): Promise<AgentMessage[]> {
    expect(sessionId).toBe("sess-conv-1");
    expect(limit).toBe(12);
    return Promise.resolve([...this.existing]);
  }

  append(sessionId: string, message: AgentMessage): Promise<void> {
    this.appended.push({ sessionId, role: message.role, message });
    return Promise.resolve();
  }
}

function userMessage(content: string, timestamp = "2026-06-10T00:00:00.000Z"): AgentMessage {
  return { role: "user", content, timestamp: Date.parse(timestamp) };
}

function assistantMessage(content: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.parse("2026-06-10T00:00:01.000Z"),
  };
}

function channelMessage(text: string): ChannelMessage {
  return {
    id: "msg-2",
    channelId: "channel-1",
    sender: { id: "human-1", displayName: "Human One", kind: "human", platform: "den-channels" },
    content: { kind: "text", text },
    timestamp: new Date("2026-06-10T00:00:02.000Z"),
  };
}

describe("conversational Agent history", () => {
  it("loads durable session history before the next Agent prompt and appends the completed turn", async () => {
    const priorUser = userMessage("first user message");
    const priorAssistant = assistantMessage("first assistant response");
    const history = new InMemoryTurnHistory([priorUser, priorAssistant]);
    const factory = new CapturingAgentFactory();
    const responder = new ConversationalAgentResponder({
      agentFactory: factory,
      eventBus: new FakeEventBus(),
      history,
      historyLimit: 12,
      logger: new FakeLogger(),
      systemPrompt: "System prompt",
    });
    const instance = new AgentInstanceImpl(
      "system-architect",
      responder,
      "inst-fresh",
      "sess-conv-1",
    );

    const response = await instance.processMessage(channelMessage("second user message"));

    expect(response).toEqual({ kind: "text", text: "fresh assistant response" });
    expect(factory.agent.prompts).toEqual([
      [priorUser, priorAssistant, userMessage("second user message", "2026-06-10T00:00:02.000Z")],
    ]);
    expect(history.appended.map((entry) => [entry.sessionId, entry.role])).toEqual([
      ["sess-conv-1", "user"],
      ["sess-conv-1", "assistant"],
    ]);
  });
});
