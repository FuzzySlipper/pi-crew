/**
 * Den Channels Gateway connection layer.
 *
 * Provides a connection abstraction (`DenConnection`) so the adapter
 * doesn't depend on transport details.  Two implementations:
 *
 * - {@link DenWebSocketConnection} — real WebSocket connection with
 *   auth, exponential-backoff reconnection, and heartbeat/ping.
 * - {@link SimulatedDenConnection} — in-memory fake for unit tests.
 *
 * @module pi-channels/den-channels/connection-types
 */

import type { RetryPolicy } from "@pi-crew/core";

// ── Wire types ──────────────────────────────────────────────────

/**
 * A raw message as received from the Den Channels Gateway.
 */
export interface DenInboundMessage {
  /** Gateway-assigned message id. */
  readonly id: string;
  /** The Den Channels id the message was posted to. */
  readonly channelId: string;
  /** Sender identity / display info. */
  readonly sender: DenSender;
  /** The message payload. */
  readonly content: DenContent;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  /** If this message is a reply, the id of the parent message. */
  readonly replyToId?: string;
  /** Optional opaque metadata bag. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Sender information in the Den wire protocol.
 */
export interface DenSender {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "human" | "agent" | "system";
}

/**
 * Content shapes carried over the Den wire protocol.
 */
export type DenContent =
  | { kind: "text"; text: string }
  | { kind: "media"; url: string; mimeType: string; altText?: string }
  | { kind: "mixed"; parts: DenContent[] };

/**
 * Payload sent to the Den Channels Gateway to post or update a message.
 */
export interface DenOutboundPayload {
  /** The content to post. */
  readonly content: DenContent;
  /** If set, this is a reply to an existing message. */
  readonly replyToId?: string;
  /** Opaque metadata to attach. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Payload for breadcrumb send/update through Den Channels.
 */
export interface DenBreadcrumbPayload {
  /** Breadcrumb id (client-assigned UUID). */
  readonly id: string;
  /** Target channel. */
  readonly channelId: string;
  /** Category: tool, research, review, decision, error. */
  readonly category: string;
  /** Lifecycle status. */
  readonly status: "started" | "in_progress" | "completed" | "failed";
  /** Short human-readable description. */
  readonly description: string;
  /** Optional metadata. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Result returned after successfully sending a message.
 */
export interface DenSendResult {
  /** Gateway-assigned message id. */
  readonly id: string;
}

// ── Connection events ───────────────────────────────────────────

/**
 * Typed events emitted by a {@link DenConnection}.
 */
export interface DenConnectionEvents {
  /** Fired when the connection opens successfully. */
  connected: () => void;

  /** Fired when the connection closes (normal or abnormal). */
  disconnected: (reason: string) => void;

  /** Fired when a reconnection attempt begins. */
  reconnecting: (attempt: number, maxAttempts: number) => void;

  /** Fired when the connection fails and reconnection is exhausted. */
  connectionFailed: (error: Error) => void;

  /** Fired when the connection receives an inbound message. */
  message: (message: DenInboundMessage) => void;

  /** Fired on non-fatal protocol / transport errors. */
  error: (error: Error) => void;
}

// ── Connection interface ────────────────────────────────────────

/**
 * Contract for a Den Channels Gateway connection.
 *
 * The adapter talks to this interface; actual transport (WebSocket,
 * simulated in-memory, etc.) lives behind it.
 */
export interface DenConnection {
  /**
   * Open the connection and authenticate.
   *
   * @throws {ConnectionError} on transport failure.
   * @throws {AuthenticationError} on auth rejection.
   */
  open(): Promise<void>;

  /** Close the connection and release resources. */
  close(): Promise<void>;

  /** Whether the connection is currently open. */
  readonly isOpen: boolean;

  /**
   * Send a message to a specific Den channel.
   *
   * @returns Gateway-assigned result containing the message id.
   */
  sendMessage(
    channelId: string,
    payload: DenOutboundPayload,
  ): Promise<DenSendResult>;

  /**
   * Update an existing message by id.
   */
  updateMessage(
    channelId: string,
    messageId: string,
    payload: DenOutboundPayload,
  ): Promise<void>;

  /**
   * Delete a message by id.
   */
  deleteMessage(channelId: string, messageId: string): Promise<void>;

  /**
   * Send or update a breadcrumb.
   */
  sendBreadcrumb(breadcrumb: DenBreadcrumbPayload): Promise<void>;

  /**
   * Update an existing breadcrumb by id.
   */
  updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<
      Pick<DenBreadcrumbPayload, "status" | "description">
    >,
  ): Promise<void>;

  /** Register an event listener.  Returns an unsubscribe function. */
  on<K extends keyof DenConnectionEvents>(
    event: K,
    listener: DenConnectionEvents[K],
  ): () => void;
}

// ── Configuration ───────────────────────────────────────────────

/**
 * Configuration for the Den Channels connection.
 */
export interface DenConnectionConfig {
  /** Den Gateway WebSocket URL (e.g. `ws://den-k8plus:4201`). */
  readonly url: string;

  /** Authentication token for the Den Gateway. */
  readonly token: string;

  /** Reconnection policy.  Defaults to {@link DEFAULT_RETRY_POLICY}. */
  readonly retryPolicy?: RetryPolicy;

  /** Heartbeat / ping interval in milliseconds.  Default 30_000. */
  readonly pingIntervalMs?: number;

  /** Connection timeout in milliseconds.  Default 10_000. */
  readonly connectionTimeoutMs?: number;
}
