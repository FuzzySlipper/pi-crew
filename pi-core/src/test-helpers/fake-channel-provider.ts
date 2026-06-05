/**
 * In-memory {@link ChannelProvider} fake for testing.
 *
 * Routes inbound messages to registered handlers, captures outbound
 * messages and breadcrumbs, and supports enough of the breadcrumb
 * lifecycle for governance tests.
 *
 * @module pi-core/test-helpers/fake-channel-provider
 */

import type {
  ChannelProvider,
  ChannelMessage,
  ChannelContent,
  ChannelInfo,
  ChannelBreadcrumb,
  MessageHandler,
  SentMessage,
} from "../channel.js";

/**
 * In-memory {@link ChannelProvider} for testing platform-agnostic code.
 */
export class FakeChannelProvider implements ChannelProvider {
  readonly name = "fake";
  readonly providerId = "fake-provider";
  isConnected = false;

  /** Every message sent via {@link sendMessage}, with the returned ack. */
  public readonly sentMessages: Array<{
    channelId: string;
    content: ChannelContent;
    result: SentMessage;
  }> = [];

  /** Every {@link updateMessage} call. */
  public readonly updatedMessages: Array<{
    channelId: string;
    messageId: string;
    content: ChannelContent;
  }> = [];

  /** Every {@link deleteMessage} call. */
  public readonly deletedMessages: Array<{
    channelId: string;
    messageId: string;
  }> = [];

  /** Every {@link sendBreadcrumb} call. */
  public readonly breadcrumbs: ChannelBreadcrumb[] = [];

  /** Every {@link updateBreadcrumb} call. */
  public readonly breadcrumbUpdates: Array<{
    breadcrumbId: string;
    update: Partial<Pick<ChannelBreadcrumb, "status" | "description">>;
  }> = [];

  /** Known channels (editable via {@link addChannel}). */
  public readonly channels: ChannelInfo[] = [];

  private messageHandler: MessageHandler | null = null;
  private nextMessageId = 1;

  // ── Connection lifecycle ───────────────────────────────────────

  connect(): Promise<void> {
    this.isConnected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.isConnected = false;
    return Promise.resolve();
  }

  // ── Channel discovery ──────────────────────────────────────────

  listChannels(): Promise<ChannelInfo[]> {
    return Promise.resolve([...this.channels]);
  }

  channelExists(channelId: string): Promise<boolean> {
    return Promise.resolve(this.channels.some((c) => c.id === channelId));
  }

  // ── Message handling ───────────────────────────────────────────

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  sendMessage(
    channelId: string,
    content: ChannelContent,
  ): Promise<SentMessage> {
    const id = `fake-msg-${String(this.nextMessageId++)}`;
    const result: SentMessage = {
      id,
      channelId,
      timestamp: new Date(),
    };
    this.sentMessages.push({ channelId, content, result });
    return Promise.resolve(result);
  }

  updateMessage(
    channelId: string,
    messageId: string,
    content: ChannelContent,
  ): Promise<void> {
    this.updatedMessages.push({ channelId, messageId, content });
    return Promise.resolve();
  }

  deleteMessage(channelId: string, messageId: string): Promise<void> {
    this.deletedMessages.push({ channelId, messageId });
    return Promise.resolve();
  }

  // ── Breadcrumbs ────────────────────────────────────────────────

  sendBreadcrumb(breadcrumb: ChannelBreadcrumb): Promise<void> {
    this.breadcrumbs.push(breadcrumb);
    return Promise.resolve();
  }

  updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<
      Pick<ChannelBreadcrumb, "status" | "description">
    >,
  ): Promise<void> {
    this.breadcrumbUpdates.push({ breadcrumbId, update });
    return Promise.resolve();
  }

  // ── Test helpers ───────────────────────────────────────────────

  /**
   * Simulate an inbound message delivered to the registered handler.
   */
  simulateInboundMessage(message: ChannelMessage): Promise<void> {
    if (this.messageHandler) {
      return this.messageHandler(message);
    }
    return Promise.resolve();
  }

  /** Add a channel to the provider's known list. */
  addChannel(channel: ChannelInfo): void {
    this.channels.push(channel);
  }

  /** Clear all captured state. */
  clear(): void {
    this.sentMessages.length = 0;
    this.updatedMessages.length = 0;
    this.deletedMessages.length = 0;
    this.breadcrumbs.length = 0;
    this.breadcrumbUpdates.length = 0;
    this.channels.length = 0;
  }
}
