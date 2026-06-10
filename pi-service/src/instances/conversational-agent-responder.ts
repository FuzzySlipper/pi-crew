/** Agent-backed responder for ordinary conversational sessions. */

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple, type AssistantMessage, type Api, type Model, type TextContent } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
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
  readonly model?: Model<Api>;
  readonly apiKey?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools?: readonly AgentTool[];
}

export interface ConversationalAgentFactory {
  create(input: ConversationalAgentFactoryInput): ConversationalAgentAdapter;
}

export interface ConversationalAgentResponderConfig {
  readonly agentFactory?: ConversationalAgentFactory;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly model?: Model<Api>;
  readonly apiKey?: string;
  readonly systemPrompt: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools?: readonly AgentTool[];
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
      getApiKey: () => input.apiKey,
      streamFn: (model, context, options) =>
        streamSimple(model, context, {
          ...options,
          maxTokens: input.maxTokens,
          temperature: input.temperature,
        }),
      initialState: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools: input.tools === undefined ? undefined : [...input.tools],
      },
    });
  }
}

export class ConversationalAgentResponder implements AgentResponder {
  readonly #agentFactory: ConversationalAgentFactory;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #model: Model<Api> | undefined;
  readonly #apiKey: string | undefined;
  readonly #systemPrompt: string;
  readonly #temperature: number | undefined;
  readonly #maxTokens: number | undefined;
  readonly #tools: readonly AgentTool[] | undefined;

  constructor(config: ConversationalAgentResponderConfig) {
    this.#agentFactory = config.agentFactory ?? new DefaultConversationalAgentFactory();
    this.#eventBus = config.eventBus;
    this.#logger = config.logger;
    this.#model = config.model;
    this.#apiKey = config.apiKey;
    this.#systemPrompt = config.systemPrompt;
    this.#temperature = config.temperature;
    this.#maxTokens = config.maxTokens;
    this.#tools = config.tools;
  }

  async respond(request: AgentResponseRequest): Promise<ChannelContent> {
    const agent = this.#agentFactory.create({
      profileId: request.profileId,
      instanceId: request.instanceId,
      systemPrompt: this.#systemPrompt,
      model: this.#model,
      apiKey: this.#apiKey,
      temperature: this.#temperature,
      maxTokens: this.#maxTokens,
      tools: this.#tools,
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
        break;
      case "message_start":
        this.#eventBus.emit({
          event: "message.started",
          payload: {
            profileId: request.profileId,
            sessionId: request.instanceId,
            messageRole: event.message.role,
          },
        });
        break;
      case "message_update":
        this.#eventBus.emit({
          event: "message.updated",
          payload: {
            profileId: request.profileId,
            sessionId: request.instanceId,
            messageRole: event.message.role,
            updateType: event.assistantMessageEvent.type,
          },
        });
        break;
      case "message_end":
        this.#eventBus.emit({
          event: "message.completed",
          payload: {
            profileId: request.profileId,
            sessionId: request.instanceId,
            messageRole: event.message.role,
          },
        });
        break;
      case "tool_execution_start":
        this.#eventBus.emit({
          event: "tool.called",
          payload: {
            profileId: request.profileId,
            sessionId: request.instanceId,
            toolName: event.toolName,
            params: event.args,
          },
        });
        break;
      case "tool_execution_update":
        this.#eventBus.emit({
          event: "tool.completed",
          payload: {
            profileId: request.profileId,
            sessionId: request.instanceId,
            toolName: event.toolName,
            success: true,
            durationMs: 0,
            result: event.partialResult,
          },
        });
        break;
      case "tool_execution_end":
        this.#eventBus.emit({
          event: "tool.completed",
          payload: {
            profileId: request.profileId,
            sessionId: request.instanceId,
            toolName: event.toolName,
            success: !event.isError,
            durationMs: 0,
            result: event.result,
          },
        });
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
