/** ChannelProvider projection helper for delegated subagent visibility events. */

import type { ChannelContent, ChannelProvider, Logger } from "@pi-crew/core";

export interface DelegationChannelProjectionConfig {
  readonly channelProvider?: ChannelProvider;
  readonly channelId?: string;
  readonly channelEnabled?: boolean;
}

export interface DelegationProjectionMessage {
  readonly eventName: string;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export class DelegationChannelProjectionFailedError extends Error {
  readonly code = "DELEGATION_CHANNEL_PROJECTION_FAILED";

  constructor(eventName: string, cause: unknown) {
    super(`Delegation channel projection failed for ${eventName}`, { cause });
    this.name = "DelegationChannelProjectionFailedError";
  }
}

export function projectDelegationMessageToChannel(input: {
  readonly channelProvider?: ChannelProvider;
  readonly channelId?: string;
  readonly logger: Logger;
  readonly message: DelegationProjectionMessage;
}): void {
  if (
    input.channelEnabled === false ||
    input.channelProvider === undefined ||
    input.channelId === undefined
  )
    return;
  void input.channelProvider
    .sendMessage(input.channelId, toChannelContent(input.message))
    .catch((cause: unknown) => {
      const error = new DelegationChannelProjectionFailedError(input.message.eventName, cause);
      input.logger.warn("delegation.projection.channel_failed", {
        code: error.code,
        eventName: input.message.eventName,
        channelId: input.channelId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    });
}

function toChannelContent(message: DelegationProjectionMessage): ChannelContent {
  return {
    kind: "text",
    text: renderMessageText(message),
    metadata: {
      eventName: message.eventName,
      ...message.details,
    },
  };
}

function renderMessageText(message: DelegationProjectionMessage): string {
  const details = detailLines(message.details);
  if (details.length === 0) return `**${message.eventName}**\n${message.summary}`;
  return `**${message.eventName}**\n${message.summary}\n${details.join("\n")}`;
}

function detailLines(details: Readonly<Record<string, unknown>>): string[] {
  return visibleDetailKeys.flatMap((key) => formatDetail(key, details[key]));
}

function formatDetail(key: string, value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  const rendered = renderValue(key, value);
  if (rendered.length === 0) return [];
  return [`- ${key}: ${rendered}`];
}

function renderValue(key: string, value: unknown): string {
  if (typeof value === "string") {
    const bounded = value.length > 280 ? `${value.slice(0, 277)}...` : value;
    return key === "task" || key === "summary" ? bounded : `\`${bounded}\``;
  }
  if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``;
  if (Array.isArray(value)) return `\`${JSON.stringify(value).slice(0, 280)}\``;
  return `\`${JSON.stringify(value).slice(0, 280)}\``;
}

const visibleDetailKeys = [
  "childSessionId",
  "parentSessionId",
  "rootSessionId",
  "profileId",
  "provider",
  "model",
  "policyId",
  "depth",
  "phase",
  "turnNumber",
  "toolName",
  "toolCallId",
  "coalescedToolCallCount",
  "coalescedCompletedCount",
  "outcome",
  "durationMs",
  "turnsUsed",
  "tokensConsumed",
  "evidenceChecked",
  "artifactCount",
  "failureCategory",
  "error",
  "recoveryGuidance",
  "task",
];
