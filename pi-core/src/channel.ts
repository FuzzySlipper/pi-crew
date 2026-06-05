/**
 * Channel abstraction — the contract between the gateway runtime and
 * every platform adapter.
 *
 * Defined in `pi-core` so every module can depend on the interface
 * without knowing about specific adapters.  Den Channels is one
 * implementation; future adapters (Discord, Telegram, API endpoint)
 * implement the same contract.
 *
 * @module pi-core/channel
 */

// ── Participant ─────────────────────────────────────────────────

/**
 * A connected participant in a conversation.
 *
 * Could be a human on Discord, an agent on Den Desktop, or a
 * system-generated message.
 */
export interface ChannelParticipant {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "human" | "agent" | "system";
  /** The platform this participant is connected through. */
  readonly platform: string;
}

// ── Content ─────────────────────────────────────────────────────

/**
 * The content of a message received from or sent to a channel.
 *
 * Supports plain text, media attachments, and mixed content
 * (e.g. a message with text + image).
 */
export type ChannelContent =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      url: string;
      mimeType: string;
      altText?: string;
    }
  | { kind: "mixed"; parts: ChannelContent[] };

// ── Message ─────────────────────────────────────────────────────

/**
 * A message routed through a channel.
 */
export interface ChannelMessage {
  readonly id: string;
  readonly channelId: string;
  readonly sender: ChannelParticipant;
  readonly content: ChannelContent;
  readonly timestamp: Date;
  readonly replyToId?: string;
  readonly metadata?: Record<string, unknown>;
}

// ── Handler & sent-message ──────────────────────────────────────

/**
 * Callback invoked when a channel adapter receives an inbound message.
 */
export type MessageHandler = (message: ChannelMessage) => Promise<void>;

/**
 * Minimal acknowledgment returned after successfully sending a message.
 */
export interface SentMessage {
  readonly id: string;
  readonly channelId: string;
  readonly timestamp: Date;
}

// ── Channel info ────────────────────────────────────────────────

/**
 * Metadata about a channel for listing / discovery.
 */
export interface ChannelInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: "direct" | "group" | "channel" | "thread";
  readonly participantCount?: number;
}

// ── Breadcrumb ──────────────────────────────────────────────────

/**
 * A short status update emitted to the human governance stream.
 *
 * Breadcrumbs let humans follow what the gateway is doing without
 * reading every message.  Typical categories: `"tool"`, `"research"`,
 * `"review"`, `"decision"`, `"error"`.
 */
export interface ChannelBreadcrumb {
  readonly id: string;
  readonly channelId: string;
  readonly category: string;
  readonly status: "started" | "in_progress" | "completed" | "failed";
  readonly description: string;
  readonly metadata?: Record<string, unknown>;
}

// ── ChannelProvider interface ───────────────────────────────────

/**
 * The contract every platform adapter must fulfill.
 *
 * This is the **only** type that code outside of `pi-channels/`
 * imports when dealing with platform communication.  No module
 * outside of `pi-channels/` should import from a specific adapter.
 */
export interface ChannelProvider {
  /** Human-readable name for logging and diagnostics. */
  readonly name: string;

  /** Unique provider identifier (e.g. `"den-channels"`). */
  readonly providerId: string;

  // ── Connection lifecycle ────────────────────────────

  /**
   * Connect to the platform.
   *
   * Idempotent — safe to call if already connected.
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the platform and release resources.
   */
  disconnect(): Promise<void>;

  /** Whether the provider is currently connected. */
  readonly isConnected: boolean;

  // ── Channels ───────────────────────────────────────

  /** List all channels this provider can see. */
  listChannels(): Promise<ChannelInfo[]>;

  /** Check whether a specific channel exists and is reachable. */
  channelExists(channelId: string): Promise<boolean>;

  // ── Message handling ────────────────────────────────

  /** Register a handler for inbound messages.  Called once at startup. */
  onMessage(handler: MessageHandler): void;

  /** Send a message to a channel. */
  sendMessage(
    channelId: string,
    content: ChannelContent,
  ): Promise<SentMessage>;

  /** Update an existing message (e.g. breadcrumb update, edit). */
  updateMessage(
    channelId: string,
    messageId: string,
    content: ChannelContent,
  ): Promise<void>;

  /** Delete a message. */
  deleteMessage(channelId: string, messageId: string): Promise<void>;

  // ── Breadcrumbs (governance stream) ─────────────────

  /** Send or update a breadcrumb in the governance stream. */
  sendBreadcrumb(breadcrumb: ChannelBreadcrumb): Promise<void>;

  /**
   * Update a breadcrumb by ID.
   *
   * @example `"started" → "completed"` as a tool finishes.
   */
  updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<Pick<ChannelBreadcrumb, "status" | "description">>,
  ): Promise<void>;

  // ── Typing indicators (optional) ─────────────────────

  /** If the platform supports typing indicators, start showing them. */
  sendTypingIndicator?(channelId: string): Promise<void>;

  /** If the platform supports typing indicators, stop showing them. */
  clearTypingIndicator?(channelId: string): Promise<void>;
}
