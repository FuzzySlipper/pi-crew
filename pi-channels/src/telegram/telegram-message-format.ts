/**
 * Translation layer between Telegram Bot API types and the abstract
 * {@link ChannelMessage} / {@link ChannelContent} types defined in pi-core.
 *
 * No other module sees Telegram-specific serialization — this is the
 * sole boundary where Telegram wire format is converted.
 *
 * @module pi-channels/telegram/telegram-message-format
 */

import type {
  ChannelMessage,
  ChannelContent,
  ChannelParticipant,
  ChannelBreadcrumb,
} from "@pi-crew/core";
import type {
  TelegramMessage,
  TelegramUpdate,
  TelegramCallbackQuery,
  TelegramUser,
  TelegramSendMessageParams,
} from "./telegram-types.js";

// ── Inbound: Telegram → ChannelMessage ─────────────────────────

/**
 * Translate a Telegram update into a {@link ChannelMessage}.
 *
 * Returns `null` if the update type is not handled (e.g. channel posts
 * without a `from` field, or updates we don't process).
 */
export function translateTelegramUpdate(update: TelegramUpdate): ChannelMessage | null {
  if (update.message) {
    return translateTelegramMessage(update.message);
  }
  if (update.callback_query) {
    return translateCallbackQuery(update.callback_query);
  }
  return null;
}

/**
 * Translate a Telegram message into a {@link ChannelMessage}.
 */
export function translateTelegramMessage(message: TelegramMessage): ChannelMessage {
  return {
    id: String(message.message_id),
    channelId: telegramChatId(message.chat.id),
    sender: translateTelegramSender(message.from),
    content: translateTelegramContent(message),
    timestamp: new Date(message.date * 1000),
    replyToId: message.reply_to_message
      ? String(message.reply_to_message.message_id)
      : undefined,
    metadata: {
      telegramChatType: message.chat.type,
      telegramMessageId: message.message_id,
    },
  };
}

/**
 * Translate a callback query into a {@link ChannelMessage}.
 *
 * Callback queries are treated as text messages containing the
 * callback data, so the agent can respond to button presses.
 */
export function translateCallbackQuery(query: TelegramCallbackQuery): ChannelMessage | null {
  if (!query.message) return null;

  return {
    id: `cbq-${query.id}`,
    channelId: telegramChatId(query.message.chat.id),
    sender: translateTelegramUser(query.from),
    content: {
      kind: "text",
      text: query.data ?? "[callback]",
      metadata: { callbackQueryId: query.id },
    },
    timestamp: new Date(),
    replyToId: String(query.message.message_id),
    metadata: {
      telegramChatType: query.message.chat.type,
      isCallbackQuery: true,
      callbackQueryId: query.id,
    },
  };
}

/**
 * Translate a Telegram sender into a {@link ChannelParticipant}.
 */
export function translateTelegramSender(user?: TelegramUser): ChannelParticipant {
  if (!user) {
    return {
      id: "unknown",
      displayName: "Unknown",
      kind: "system",
      platform: "telegram",
    };
  }
  return translateTelegramUser(user);
}

/**
 * Translate a Telegram user into a {@link ChannelParticipant}.
 */
export function translateTelegramUser(user: TelegramUser): ChannelParticipant {
  const displayName = user.last_name
    ? `${user.first_name} ${user.last_name}`
    : user.first_name;

  return {
    id: String(user.id),
    displayName,
    kind: user.is_bot ? "agent" : "human",
    platform: "telegram",
  };
}

/**
 * Extract {@link ChannelContent} from a Telegram message.
 *
 * Handles text, photo (with optional caption), document (with
 * optional caption), and mixed content (photo + caption).
 */
export function translateTelegramContent(message: TelegramMessage): ChannelContent {
  // Photo message (may have caption)
  if (message.photo && message.photo.length > 0) {
    // Use the largest photo variant
    const photo = message.photo[message.photo.length - 1]!;
    const mediaContent: ChannelContent = {
      kind: "media",
      url: `telegram://file/${photo.file_id}`,
      mimeType: "image/jpeg",
      altText: message.caption,
      metadata: {
        telegramFileId: photo.file_id,
        width: photo.width,
        height: photo.height,
      },
    };

    if (message.caption) {
      return {
        kind: "mixed",
        parts: [
          mediaContent,
          { kind: "text", text: message.caption },
        ],
      };
    }
    return mediaContent;
  }

  // Document message (may have caption)
  if (message.document) {
    const mediaContent: ChannelContent = {
      kind: "media",
      url: `telegram://file/${message.document.file_id}`,
      mimeType: message.document.mime_type ?? "application/octet-stream",
      altText: message.caption ?? message.document.file_name,
      metadata: {
        telegramFileId: message.document.file_id,
        fileName: message.document.file_name,
      },
    };

    if (message.caption) {
      return {
        kind: "mixed",
        parts: [
          mediaContent,
          { kind: "text", text: message.caption },
        ],
      };
    }
    return mediaContent;
  }

  // Plain text message
  return {
    kind: "text",
    text: message.text ?? "",
  };
}

// ── Outbound: ChannelContent → Telegram text ────────────────────

/**
 * Convert {@link ChannelContent} to a Telegram message text string.
 *
 * Text content is escaped for MarkdownV2.  Media content produces
 * a description string.  Mixed content concatenates parts.
 */
export function channelContentToTelegramText(content: ChannelContent): string {
  switch (content.kind) {
    case "text":
      return escapeMarkdownV2(content.text);
    case "media":
      return escapeMarkdownV2(
        content.altText ?? `[${content.mimeType} file]`,
      );
    case "mixed":
      return content.parts.map(channelContentToTelegramText).join("\n");
  }
}

/**
 * Build Telegram `sendMessage` params from a channel ID and content.
 */
export function buildSendMessageParams(
  channelId: string,
  content: ChannelContent,
  replyToMessageId?: string,
): TelegramSendMessageParams {
  const text = channelContentToTelegramText(content);
  const params: TelegramSendMessageParams = {
    chat_id: channelId,
    text,
    parse_mode: "MarkdownV2",
    ...(replyToMessageId ? { reply_to_message_id: Number(replyToMessageId) } : {}),
  };
  return params;
}

// ── Breadcrumb translation ─────────────────────────────────────

/**
 * Convert a {@link ChannelBreadcrumb} to a human-readable text
 * message for Telegram.
 *
 * Telegram doesn't have a native breadcrumb concept, so we
 * format them as status messages.
 */
export function breadcrumbToTelegramText(breadcrumb: ChannelBreadcrumb): string {
  const statusEmoji = breadcrumbStatusEmoji(breadcrumb.status);
  const text = `${statusEmoji} \\[${escapeMarkdownV2(breadcrumb.category)}\\] ${escapeMarkdownV2(breadcrumb.description)}`;
  return text;
}

function breadcrumbStatusEmoji(status: ChannelBreadcrumb["status"]): string {
  switch (status) {
    case "started": return "⏳";
    case "in_progress": return "🔄";
    case "completed": return "✅";
    case "failed": return "❌";
  }
}

// ── MarkdownV2 escaping ─────────────────────────────────────────

/**
 * Characters that must be escaped in Telegram MarkdownV2 format.
 *
 * Reference: https://core.telegram.org/bots/api#markdownv2-style
 */
const MARKDOWN_V2_SPECIAL_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Escape special characters for Telegram MarkdownV2 format.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL_CHARS, "\\$1");
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Convert a Telegram numeric chat ID to a string channel ID.
 */
export function telegramChatId(chatId: number): string {
  return String(chatId);
}
