/**
 * Den Channels adapter — the first concrete {@link ChannelProvider}.
 *
 * Translates Den Channels Gateway wire protocol into the abstract
 * {@link ChannelMessage} / {@link ChannelContent} / {@link ChannelBreadcrumb}
 * types used by the rest of the gateway, and sends outbound messages
 * and breadcrumbs through the Den connection.
 *
 * @module pi-channels/den-channels/den-channels-adapter
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
  ChannelMembershipProvider,
  ChannelPresenceProvider,
  ChannelMembershipUpsert,
  ChannelMembership,
  ChannelSubscriptionUpsert,
  ChannelSubscription,
  ChannelSubscriptionRelease,
  ChannelPresenceQuery,
  ChannelPresence,
  ChannelSubscriptionStatusUpdate,
} from "@pi-crew/core";
import {
  ConnectionError,
  isChannelMembershipProvider,
  isChannelPresenceProvider,
} from "@pi-crew/core";
import type { DenConnection } from "./connection.js";
import {
  translateInboundMessage,
  translateOutboundContent,
  translateBreadcrumbToDen,
} from "./message-format.js";

/**
 * Configuration for {@link DenChannelsAdapter}.
 */
export interface DenChannelsAdapterConfig {
  /** Human-readable name for logging / diagnostics. */
  readonly name?: string;
  /** Unique provider identifier (default `"den-channels"`). */
  readonly providerId?: string;
}

/**
 * Implements {@link ChannelProvider} for the Den Channels Gateway.
 *
 * The adapter handles three concerns that no other module sees:
 *
 * 1. **Connection management** — delegates to {@link DenConnection}
 *    for WebSocket lifecycle, reconnection, and auth.
 * 2. **Message format translation** — converts Den wire format to
 *    {@link ChannelMessage} / {@link ChannelContent} via
 *    {@link message-format.ts}.
 * 3. **Routing** — routes inbound messages to the registered
 *    {@link MessageHandler}, and sends outbound messages/breadcrumbs
 *    through the connection.
 */
export class DenChannelsAdapter implements ChannelProvider, ChannelMembershipProvider, ChannelPresenceProvider {
  readonly name: string;
  readonly providerId: string;

  #connection: DenConnection;
  #logger: Logger;
  #messageHandler: MessageHandler | null = null;
  #unsubscribers: Array<() => void> = [];

  constructor(
    connection: DenConnection,
    logger: Logger,
    config?: DenChannelsAdapterConfig,
  ) {
    this.#connection = connection;
    this.#logger = logger;
    this.name = config?.name ?? "Den Channels Gateway";
    this.providerId = config?.providerId ?? "den-channels";
  }

  // ── Connection lifecycle ──────────────────────────────────────

  get isConnected(): boolean {
    return this.#connection.isOpen;
  }

  async connect(): Promise<void> {
    if (this.#connection.isOpen) return; // idempotent

    this.#logger.info("DenChannelsAdapter connecting", {
      provider: this.name,
    });

    // Subscribe to connection events before opening
    this.#unsubscribers.push(
      this.#connection.on("message", (denMessage) => {
        const channelMessage = translateInboundMessage(denMessage);
        this.#logger.debug("Inbound Den message translated", {
          messageId: channelMessage.id,
          channelId: channelMessage.channelId,
        });
        void this.#routeMessage(channelMessage);
      }),
    );

    this.#unsubscribers.push(
      this.#connection.on("error", (err) => {
        this.#logger.error("Den connection error", { error: err.message });
      }),
    );

    this.#unsubscribers.push(
      this.#connection.on("connected", () => {
        this.#logger.info("DenChannelsAdapter connected", {
          provider: this.name,
        });
      }),
    );

    this.#unsubscribers.push(
      this.#connection.on("disconnected", (reason) => {
        this.#logger.warn("DenChannelsAdapter disconnected", {
          provider: this.name,
          reason,
        });
      }),
    );

    this.#unsubscribers.push(
      this.#connection.on("reconnecting", (attempt, max) => {
        this.#logger.info("Den connection reconnecting", {
          attempt,
          max,
        });
      }),
    );

    this.#unsubscribers.push(
      this.#connection.on("connectionFailed", (err) => {
        this.#logger.error("Den connection failed permanently", {
          error: err.message,
        });
      }),
    );

    await this.#connection.open();
  }

  async disconnect(): Promise<void> {
    this.#logger.info("DenChannelsAdapter disconnecting", {
      provider: this.name,
    });

    // Unsubscribe all event listeners
    for (const unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers.length = 0;
    this.#messageHandler = null;

    await this.#connection.close();
  }

  // ── Channel discovery ─────────────────────────────────────────

  async listChannels(): Promise<ChannelInfo[]> {
    // Den Channels doesn't have a channel-listing protocol yet;
    // channels are discovered via inbound messages and breadcrumbs.
    await Promise.resolve();
    return [];
  }

  async channelExists(channelId: string): Promise<boolean> {
    // In the current Den Channels design, channels exist implicitly
    // as they appear in messages.
    void channelId; // used for future lookup
    await Promise.resolve();
    return true;
  }

  // ── Message handling ──────────────────────────────────────────

  onMessage(handler: MessageHandler): void {
    this.#messageHandler = handler;
  }

  async sendMessage(
    channelId: string,
    content: ChannelContent,
  ): Promise<SentMessage> {
    const payload = translateOutboundContent(content);
    const result = await this.#connection.sendMessage(channelId, payload);
    return {
      id: result.id,
      channelId,
      timestamp: new Date(),
    };
  }

  async updateMessage(
    channelId: string,
    messageId: string,
    content: ChannelContent,
  ): Promise<void> {
    const payload = translateOutboundContent(content);
    await this.#connection.updateMessage(channelId, messageId, payload);
  }

  async deleteMessage(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.#connection.deleteMessage(channelId, messageId);
  }

  // ── Breadcrumbs (governance stream) ───────────────────────────

  async sendBreadcrumb(breadcrumb: ChannelBreadcrumb): Promise<void> {
    const denBreadcrumb = translateBreadcrumbToDen(breadcrumb);
    await this.#connection.sendBreadcrumb(denBreadcrumb);
  }

  async updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<Pick<ChannelBreadcrumb, "status" | "description">>,
  ): Promise<void> {
    await this.#connection.updateBreadcrumb(breadcrumbId, update);
  }

  // ── Typing indicators (optional) ──────────────────────────────

  async sendTypingIndicator(channelId: string): Promise<void> {
    this.#logger.debug("Typing indicator requested (unsupported)", {
      channelId,
    });
    await Promise.resolve();
  }

  async clearTypingIndicator(channelId: string): Promise<void> {
    this.#logger.debug("Clear typing indicator (unsupported)", {
      channelId,
    });
    await Promise.resolve();
  }

  async upsertMembership(input: ChannelMembershipUpsert): Promise<ChannelMembership> {
    const provider = this.membershipProvider();
    return provider.upsertMembership(input);
  }

  async upsertSubscription(input: ChannelSubscriptionUpsert): Promise<ChannelSubscription> {
    const provider = this.membershipProvider();
    return provider.upsertSubscription(input);
  }

  async releaseSubscription(input: ChannelSubscriptionRelease): Promise<void> {
    const provider = this.membershipProvider();
    await provider.releaseSubscription(input);
  }

  async getPresence(input: ChannelPresenceQuery): Promise<readonly ChannelPresence[]> {
    const provider = this.presenceProvider();
    return provider.getPresence(input);
  }

  async updateSubscriptionStatus(input: ChannelSubscriptionStatusUpdate): Promise<void> {
    const provider = this.presenceProvider();
    await provider.updateSubscriptionStatus(input);
  }

  // ── Internals ─────────────────────────────────────────────────

  private membershipProvider(): ChannelMembershipProvider {
    if (!isChannelMembershipProvider(this.#connection)) {
      throw new ConnectionError("Den connection does not support channel membership operations");
    }
    return this.#connection;
  }

  private presenceProvider(): ChannelPresenceProvider {
    if (!isChannelPresenceProvider(this.#connection)) {
      throw new ConnectionError("Den connection does not support channel presence operations");
    }
    return this.#connection;
  }

  async #routeMessage(message: ChannelMessage): Promise<void> {
    if (this.#messageHandler) {
      try {
        await this.#messageHandler(message);
      } catch (err: unknown) {
        this.#logger.error("Message handler threw", {
          error: err instanceof Error ? err.message : String(err),
          messageId: message.id,
          channelId: message.channelId,
        });
      }
    } else {
      this.#logger.warn("No message handler registered; discarding message", {
        messageId: message.id,
        channelId: message.channelId,
      });
    }
  }
}
