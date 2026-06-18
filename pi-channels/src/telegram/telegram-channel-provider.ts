/**
 * Telegram channel provider — implements {@link ChannelProvider}
 * for the Telegram Bot API.
 *
 * All messages from all chats route to a **single** agent session.
 * The `channelId` is the Telegram chat ID (as a string), but no
 * per-chat session splitting occurs — the session manager sees
 * one unified conversation.
 *
 * @module pi-channels/telegram/telegram-channel-provider
 */

import type {
  ChannelProvider,
  ChannelMessage,
  ChannelContent,
  ChannelInfo,
  ChannelBreadcrumb,
  MessageHandler,
  SentMessage,
  Logger,
} from "@pi-crew/core";
import type {
  TelegramConnection,
  TelegramProviderConfig,
} from "./telegram-types.js";
import {
  translateTelegramUpdate,
  buildSendMessageParams,
  breadcrumbToTelegramText,
  channelContentToTelegramText,
  telegramChatId,
} from "./telegram-message-format.js";

/**
 * Configuration for {@link TelegramChannelProvider}.
 */
export interface TelegramChannelProviderConfig {
  /** Human-readable name for logging / diagnostics. */
  readonly name?: string;
  /** Unique provider identifier (default `"telegram"`). */
  readonly providerId?: string;
}

/**
 * Implements {@link ChannelProvider} for the Telegram Bot API.
 *
 * The adapter handles three concerns:
 *
 * 1. **Connection management** — delegates to {@link TelegramConnection}
 *    for HTTP polling lifecycle.
 * 2. **Message format translation** — converts Telegram updates to
 *    {@link ChannelMessage} / {@link ChannelContent} via
 *    `telegram-message-format.ts`.
 * 3. **Routing** — routes inbound messages to the registered
 *    {@link MessageHandler}, and sends outbound messages through
 *    the connection.
 *
 * DESIGN: Single-session routing. Rationale: Unlike Hermes which
 * creates per-platform sessions, pi-crew maintains one unified
 * agent session regardless of ingress platform.  All Telegram
 * messages flow to the same handler.
 */
export class TelegramChannelProvider implements ChannelProvider {
  readonly name: string;
  readonly providerId: string;

  #connection: TelegramConnection;
  #logger: Logger;
  #config: TelegramProviderConfig;
  #messageHandler: MessageHandler | null = null;
  #unsubscribers: Array<() => void> = [];
  #knownChats = new Map<string, ChannelInfo>();
  #breadcrumbMessageIds = new Map<string, number>();

  constructor(
    connection: TelegramConnection,
    logger: Logger,
    providerConfig: TelegramProviderConfig,
    adapterConfig?: TelegramChannelProviderConfig,
  ) {
    this.#connection = connection;
    this.#logger = logger;
    this.#config = providerConfig;
    this.name = adapterConfig?.name ?? "Telegram Bot";
    this.providerId = adapterConfig?.providerId ?? "telegram";
  }

  // ── Connection lifecycle ──────────────────────────────────────

  get isConnected(): boolean {
    return this.#connection.isOpen;
  }

  async connect(): Promise<void> {
    if (this.#connection.isOpen) return; // idempotent

    this.#logger.info("TelegramChannelProvider connecting", {
      provider: this.name,
    });

    // Subscribe to connection events
    this.#unsubscribers.push(
      this.#connection.on("update", (update) => {
        const channelMessage = translateTelegramUpdate(update);
        if (!channelMessage) {
          this.#logger.debug("Ignoring unhandled Telegram update type", {
            updateId: update.update_id,
          });
          return;
        }

        // Check chat allowlist
        if (!this.#isChatAllowed(channelMessage.channelId)) {
          this.#logger.debug("Ignoring message from non-allowed chat", {
            channelId: channelMessage.channelId,
          });
          return;
        }

        // Track known chats
        this.#trackChat(channelMessage);

        this.#logger.debug("Inbound Telegram message translated", {
          messageId: channelMessage.id,
          channelId: channelMessage.channelId,
        });
        void this.#routeMessage(channelMessage);
      }),
    );

    this.#unsubscribers.push(
      this.#connection.on("error", (err) => {
        this.#logger.error("Telegram connection error", {
          error: err.message,
        });
      }),
    );

    this.#unsubscribers.push(
      this.#connection.on("connected", () => {
        this.#logger.info("TelegramChannelProvider connected", {
          provider: this.name,
        });
      }),
    );

    this.#unsubscribers.push(
      this.#connection.on("disconnected", (reason) => {
        this.#logger.warn("TelegramChannelProvider disconnected", {
          provider: this.name,
          reason,
        });
      }),
    );

    await this.#connection.open();
  }

  async disconnect(): Promise<void> {
    this.#logger.info("TelegramChannelProvider disconnecting", {
      provider: this.name,
    });

    for (const unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers.length = 0;
    this.#messageHandler = null;

    await this.#connection.close();
  }

  // ── Channel discovery ─────────────────────────────────────────

  async listChannels(): Promise<ChannelInfo[]> {
    await Promise.resolve();
    return [...this.#knownChats.values()];
  }

  async channelExists(channelId: string): Promise<boolean> {
    await Promise.resolve();
    return this.#knownChats.has(channelId);
  }

  // ── Message handling ──────────────────────────────────────────

  onMessage(handler: MessageHandler): void {
    this.#messageHandler = handler;
  }

  async sendMessage(
    channelId: string,
    content: ChannelContent,
  ): Promise<SentMessage> {
    const params = buildSendMessageParams(channelId, content);
    const result = await this.#connection.sendMessage(params);
    return {
      id: String(result.message_id),
      channelId,
      timestamp: new Date(result.date * 1000),
    };
  }

  async updateMessage(
    channelId: string,
    messageId: string,
    content: ChannelContent,
  ): Promise<void> {
    const text = channelContentToTelegramText(content);
    await this.#connection.editMessageText({
      chat_id: channelId,
      message_id: Number(messageId),
      text,
      parse_mode: "MarkdownV2",
    });
  }

  async deleteMessage(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.#connection.deleteMessage({
      chat_id: channelId,
      message_id: Number(messageId),
    });
  }

  // ── Breadcrumbs (governance stream) ───────────────────────────

  async sendBreadcrumb(breadcrumb: ChannelBreadcrumb): Promise<void> {
    // DESIGN: Telegram has no native breadcrumb concept.
    // Rationale: Send formatted status messages to the breadcrumb's
    // target channel.  Track message IDs so we can update them.
    const text = breadcrumbToTelegramText(breadcrumb);
    const result = await this.#connection.sendMessage({
      chat_id: breadcrumb.channelId,
      text,
      parse_mode: "MarkdownV2",
    });
    this.#breadcrumbMessageIds.set(breadcrumb.id, result.message_id);
  }

  async updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<Pick<ChannelBreadcrumb, "status" | "description">>,
  ): Promise<void> {
    const messageId = this.#breadcrumbMessageIds.get(breadcrumbId);
    if (!messageId) {
      this.#logger.debug("Cannot update breadcrumb — original message not tracked", {
        breadcrumbId,
      });
      return;
    }

    // Rebuild the text with updated fields
    // We don't have the full original breadcrumb, so format a minimal update
    const statusText = update.status ?? "in_progress";
    const description = update.description ?? "";
    const text = `🔄 \\[${statusText}\\] ${description}`;

    // We need a chat_id to edit — but we don't store it per breadcrumb.
    // For now, log as unsupported.  A future improvement could track
    // chat_id alongside message_id.
    this.#logger.debug("Breadcrumb update not fully supported on Telegram", {
      breadcrumbId,
      messageId,
      update,
    });
    void text; // suppress unused warning for now
  }

  // ── Typing indicators ─────────────────────────────────────────

  async sendTypingIndicator(channelId: string): Promise<void> {
    try {
      await this.#connection.sendChatAction({
        chat_id: channelId,
        action: "typing",
      });
    } catch (error) {
      this.#logger.debug("Failed to send typing indicator", {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async clearTypingIndicator(channelId: string): Promise<void> {
    // Telegram typing indicators auto-clear after ~5 seconds
    // or when a message is sent.  No explicit clear API.
    this.#logger.debug("Clear typing indicator (auto-clear on Telegram)", {
      channelId,
    });
    await Promise.resolve();
  }

  // ── Private ───────────────────────────────────────────────────

  #isChatAllowed(channelId: string): boolean {
    if (!this.#config.allowedChats || this.#config.allowedChats.length === 0) {
      return true; // no allowlist = all chats allowed
    }
    return this.#config.allowedChats.includes(channelId);
  }

  #trackChat(message: ChannelMessage): void {
    const chatId = message.channelId;
    if (!this.#knownChats.has(chatId)) {
      const chatType = (message.metadata?.["telegramChatType"] as string) ?? "private";
      this.#knownChats.set(chatId, {
        id: chatId,
        name: `Telegram ${chatType} ${chatId}`,
        kind: chatType === "private" ? "direct" : "group",
      });
    }
  }

  async #routeMessage(message: ChannelMessage): Promise<void> {
    if (!this.#messageHandler) {
      this.#logger.warn("No message handler registered, dropping message", {
        messageId: message.id,
      });
      return;
    }

    try {
      await this.#messageHandler(message);
    } catch (error) {
      this.#logger.error("Message handler threw", {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ── Re-exports for convenience ──────────────────────────────────

export { telegramChatId } from "./telegram-message-format.js";
