/**
 * Translation layer between Den Channels wire format and the abstract
 * {@link ChannelMessage} / {@link ChannelContent} / {@link ChannelBreadcrumb}
 * types defined in `pi-core`.
 *
 * No other module sees the Den wire format — this module is the sole
 * boundary where Den-specific serialization happens.
 *
 * @module pi-channels/den-channels/message-format
 */

import type {
  ChannelMessage,
  ChannelContent,
  ChannelParticipant,
  ChannelBreadcrumb,
} from "@pi-crew/core";
import type {
  DenInboundMessage,
  DenContent,
  DenBreadcrumbPayload,
  DenOutboundPayload,
} from "./connection.js";

// ── Inbound: Den wire → ChannelMessage ─────────────────────────

/**
 * Translate a raw Den Channels inbound message into the abstract
 * {@link ChannelMessage} used by the rest of the gateway.
 */
export function translateInboundMessage(
  raw: DenInboundMessage,
): ChannelMessage {
  return {
    id: raw.id,
    channelId: raw.channelId,
    sender: translateDenSender(raw.sender),
    content: translateDenContent(raw.content),
    timestamp: new Date(raw.timestamp),
    replyToId: raw.replyToId,
    metadata: raw.metadata,
  };
}

/**
 * Translate a Den sender into a {@link ChannelParticipant}.
 */
export function translateDenSender(
  sender: DenInboundMessage["sender"],
): ChannelParticipant {
  return {
    id: sender.id,
    displayName: sender.displayName,
    kind: sender.kind,
    platform: "den-channels",
  };
}

/**
 * Translate Den wire content into the abstract {@link ChannelContent}.
 */
export function translateDenContent(
  content: DenContent,
): ChannelContent {
  switch (content.kind) {
    case "text":
      return { kind: "text", text: content.text };
    case "media":
      return {
        kind: "media",
        url: content.url,
        mimeType: content.mimeType,
        altText: content.altText,
      };
    case "mixed":
      return {
        kind: "mixed",
        parts: content.parts.map(translateDenContent),
      };
  }
}

// ── Outbound: ChannelContent → Den payload ─────────────────────

/**
 * Translate abstract {@link ChannelContent} to a Den outbound message
 * payload suitable for {@link DenConnection.sendMessage}.
 */
export function translateOutboundContent(
  content: ChannelContent,
  options?: { replyToId?: string; metadata?: Record<string, unknown> },
): DenOutboundPayload {
  const denContent = channelContentToDenContent(content);
  const payload: DenOutboundPayload = {
    content: denContent,
    ...(options?.replyToId ? { replyToId: options.replyToId } : {}),
    ...(options?.metadata ? { metadata: options.metadata } : {}),
  };
  return payload;
}

/**
 * Translate abstract {@link ChannelContent} into {@link DenContent}.
 */
export function channelContentToDenContent(
  content: ChannelContent,
): DenContent {
  switch (content.kind) {
    case "text":
      return { kind: "text", text: content.text };
    case "media":
      return {
        kind: "media",
        url: content.url,
        mimeType: content.mimeType,
        altText: content.altText,
      };
    case "mixed":
      return {
        kind: "mixed",
        parts: content.parts.map(channelContentToDenContent),
      };
  }
}

// ── Breadcrumb translation ─────────────────────────────────────

/**
 * Translate a {@link ChannelBreadcrumb} into the Den breadcrumb
 * payload for sending / updating via {@link DenConnection}.
 */
export function translateBreadcrumbToDen(
  breadcrumb: ChannelBreadcrumb,
): DenBreadcrumbPayload {
  return {
    id: breadcrumb.id,
    channelId: breadcrumb.channelId,
    category: breadcrumb.category,
    status: breadcrumb.status,
    description: breadcrumb.description,
    metadata: breadcrumb.metadata,
  };
}
