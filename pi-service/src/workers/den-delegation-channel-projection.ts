/** ChannelProvider projection helper for delegated subagent visibility events. */

import type { ChannelContent, ChannelProvider, Logger } from "@pi-crew/core";

export interface DelegationChannelProjectionConfig {
  readonly channelProvider?: ChannelProvider;
  readonly channelId?: string;
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
  if (input.channelProvider === undefined || input.channelId === undefined) return;
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
    text: `**${message.eventName}**\n${message.summary}`,
    metadata: {
      eventName: message.eventName,
      ...message.details,
    },
  };
}
