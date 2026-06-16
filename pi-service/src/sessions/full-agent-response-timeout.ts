import type { ChannelContent, ChannelMessage, ChannelProvider, EventBus, Logger } from "@pi-crew/core";
import type { AgentInstance } from "../instances/agent-instance.js";
import type { SessionRecord } from "./types.js";
import { withReplyIdentity } from "./session-reply-identity.js";

export type ResponseTimeoutPhase = "timed_out" | "settled" | "failed";
export type ResponseTimeoutPresenceEmitter = (
  record: SessionRecord,
  reason: "response_timeout" | "routed",
  subscriptionStatus: "active" | "degraded",
  membershipStatus: "active",
) => void;

export interface FullAgentResponseTimeoutInput {
  readonly channel: ChannelProvider;
  readonly message: ChannelMessage;
  readonly record: SessionRecord;
  readonly instance: AgentInstance;
  readonly operation: Promise<ChannelContent>;
  readonly timeoutMs: number;
  readonly startedAt: number;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly emitPresence: ResponseTimeoutPresenceEmitter;
}

export async function handleFullAgentResponseTimeout(
  input: FullAgentResponseTimeoutInput,
): Promise<void> {
  const { channel, message, record, instance, operation, timeoutMs, startedAt } = input;
  emitResponseTimeout(input, "timed_out", true);
  input.emitPresence(record, "response_timeout", "degraded", "active");
  input.logger.error("Full-agent response timed out; keeping session busy until underlying run settles", {
    sessionId: record.id,
    channelId: message.channelId,
    instanceId: instance.id,
    timeoutMs,
    elapsedMs: Date.now() - startedAt,
  });
  await channel.sendMessage(message.channelId, withReplyIdentity(timeoutNotice(), message));
  try {
    await operation;
    emitResponseTimeout(input, "settled", false);
    input.emitPresence(record, "routed", "active", "active");
  } catch (settleError: unknown) {
    const error = settleError instanceof Error ? settleError.message : String(settleError);
    emitResponseTimeout(input, "failed", false, error);
    input.emitPresence(record, "routed", "degraded", "active");
    input.logger.error("Timed-out full-agent run failed while settling", {
      sessionId: record.id,
      channelId: message.channelId,
      instanceId: instance.id,
      error,
    });
  }
}

function timeoutNotice(): ChannelContent {
  return {
    kind: "text",
    text: "The agent response exceeded its configured timeout. The session remains busy while the in-flight run settles; follow-up turns will wait instead of racing it.",
  };
}

function emitResponseTimeout(
  input: FullAgentResponseTimeoutInput,
  phase: ResponseTimeoutPhase,
  stillSettling: boolean,
  error?: string,
): void {
  const { eventBus, record, instance, message, timeoutMs, startedAt } = input;
  eventBus.emit({
    event: "session.response_timeout",
    payload: {
      sessionId: record.id,
      profileId: record.profileId,
      instanceId: instance.id,
      channelId: message.channelId,
      messageId: message.id,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      phase,
      stillSettling,
      ...(error === undefined ? {} : { error }),
    },
  });
}
