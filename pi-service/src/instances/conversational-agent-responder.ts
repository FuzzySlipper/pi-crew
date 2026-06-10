/** Agent-backed responder for ordinary conversational sessions. */

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { EventBus, Logger, ChannelContent } from "@pi-crew/core";
import { ConfigurationError } from "@pi-crew/core";
import type {
  AgentResponseRequest,
  AgentResponder,
  AgentResponderFactory,
  AgentResponderFactoryContext,
} from "./agent-responder.js";

export interface ConversationalAgentState {
  readonly messages: AgentMessage[];
}

export interface ConversationalAgentAdapter {
  readonly state: ConversationalAgentState;
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
  prompt(messages: AgentMessage[]): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): void;
}

export interface ConversationalAgentFactoryInput {
  readonly profileId: string;
  readonly instanceId: string;
  readonly systemPrompt: string;
}

export interface ConversationalAgentFactory {
  create(input: ConversationalAgentFactoryInput): ConversationalAgentAdapter;
}

export interface ConversationalAgentResponderConfig {
  readonly agentFactory?: ConversationalAgentFactory;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly systemPrompt: string;
}

export interface ConversationalAgentRuntimeBuilder {
  build(context: AgentResponderFactoryContext): AgentResponder;
}

export class ConversationalAgentResponderFactory implements AgentResponderFactory {
  constructor(private readonly builder: ConversationalAgentRuntimeBuilder) {}

  createResponder(context: AgentResponderFactoryContext): AgentResponder {
    return this.builder.build(context);
  }
}

export class DefaultConversationalAgentFactory implements ConversationalAgentFactory {
  create(input: ConversationalAgentFactoryInput): ConversationalAgentAdapter {
    return new Agent({
      sessionId: input.instanceId,
      initialState: {
        systemPrompt: input.systemPrompt,
      },
    });
  }
}

export class ConversationalAgentResponder implements AgentResponder {
  readonly #agentFactory: ConversationalAgentFactory;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #systemPrompt: string;

  constructor(config: ConversationalAgentResponderConfig) {
    this.#agentFactory = config.agentFactory ?? new DefaultConversationalAgentFactory();
    this.#eventBus = config.eventBus;
    this.#logger = config.logger;
    this.#systemPrompt = config.systemPrompt;
  }

  async respond(request: AgentResponseRequest): Promise<ChannelContent> {
    const agent = this.#agentFactory.create({
      profileId: request.profileId,
      instanceId: request.instanceId,
      systemPrompt: this.#systemPrompt,
    });
    this.#logger.debug("Starting Agent-backed conversational response", {
      profileId: request.profileId,
      instanceId: request.instanceId,
      channelId: request.message.channelId,
    });
    const unsubscribe = agent.subscribe((event) => {
      this.#emitLifecycleEvent(event, request);
    });

    try {
      await agent.prompt([toUserAgentMessage(request)]);
      await agent.waitForIdle();
      const response = responseFromMessages(agent.state.messages);
      this.#logger.debug("Completed Agent-backed conversational response", {
        profileId: request.profileId,
        instanceId: request.instanceId,
      });
      return response;
    } finally {
      unsubscribe();
    }
  }

  #emitLifecycleEvent(event: AgentEvent, request: AgentResponseRequest): void {
    switch (event.type) {
      case "turn_start":
        this.#eventBus.emit({
          event: "turn.started",
          payload: {
            profileId: request.profileId,
            sessionId: request.instanceId,
            turnNumber: 1,
          },
        });
        break;
      case "turn_end":
        this.#eventBus.emit({
          event: "turn.completed",
          payload: {
            profileId: request.profileId,
            sessionId: request.instanceId,
            turnNumber: 1,
            durationMs: 0,
          },
        });
        break;
      case "agent_start":
      case "agent_end":
      case "message_start":
      case "message_update":
      case "message_end":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        break;
      default:
        assertNever(event);
    }
  }
}

function toUserAgentMessage(request: AgentResponseRequest): AgentMessage {
  return {
    role: "user",
    content: contentToText(request.message.content),
    timestamp: request.message.timestamp.getTime(),
  };
}

function contentToText(content: AgentResponseRequest["message"]["content"]): string {
  if (content.kind === "text") {
    return content.text;
  }
  return "[non-text content]";
}

function responseFromMessages(messages: readonly AgentMessage[]): ChannelContent {
  const assistant = lastAssistantMessage(messages);
  if (assistant === undefined) {
    throw new ConfigurationError("Conversational Agent completed without an assistant response");
  }
  const text = assistant.content
    .filter(isTextContent)
    .map((part) => part.text)
    .join("");
  return { kind: "text", text };
}

function lastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAssistantMessage(message)) {
      return message;
    }
  }
  return undefined;
}

function isAssistantMessage(message: AgentMessage | undefined): message is AssistantMessage {
  return message?.role === "assistant";
}

function isTextContent(part: AssistantMessage["content"][number]): part is TextContent {
  return part.type === "text";
}

function assertNever(value: never): never {
  throw new ConfigurationError(`Unhandled conversational Agent event: ${JSON.stringify(value)}`);
}
