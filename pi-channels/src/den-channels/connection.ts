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
 * @module pi-channels/den-channels/connection
 */

import { ConnectionError, AuthenticationError } from "@pi-crew/core";
import type { Logger } from "@pi-crew/core";
import { DEFAULT_RETRY_POLICY } from "@pi-crew/core";
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

// ── WebSocket connection ────────────────────────────────────────

/**
 * Real WebSocket-based connection to the Den Channels Gateway.
 *
 * Handles:
 * - WebSocket lifecycle (open / close)
 * - Authentication via token in the initial handshake
 * - Exponential-backoff reconnection on unexpected close
 * - Heartbeat ping/pong to detect stale connections
 */
export class DenWebSocketConnection implements DenConnection {
  readonly #url: string;
  readonly #token: string;
  readonly #retryPolicy: RetryPolicy;
  readonly #pingIntervalMs: number;
  readonly #connectionTimeoutMs: number;
  readonly #logger: Logger;
  readonly #listeners = new Map<
    keyof DenConnectionEvents,
    Set<DenConnectionEvents[keyof DenConnectionEvents]>
  >();

  #ws: WebSocket | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectAttempt = 0;
  #closed = false;
  #opened = false;

  constructor(config: DenConnectionConfig, logger: Logger) {
    this.#url = config.url;
    this.#token = config.token;
    this.#retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.#pingIntervalMs = config.pingIntervalMs ?? 30_000;
    this.#connectionTimeoutMs = config.connectionTimeoutMs ?? 10_000;
    this.#logger = logger;
  }

  // ── Public API ──────────────────────────────────────────────

  get isOpen(): boolean {
    return this.#opened && this.#ws?.readyState === WebSocket.OPEN;
  }

  async open(): Promise<void> {
    if (this.#opened) return; // idempotent

    this.#closed = false;
    this.#reconnectAttempt = 0;

    try {
      await this.#connect();
    } catch {
      void this.#startReconnect();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stopHeartbeat();
    if (this.#ws) {
      const ws = this.#ws;
      this.#ws = null;
      ws.close(1000, "client-close");
    }
    this.#opened = false;
    // satisfy require-await
    await Promise.resolve();
  }

  async sendMessage(
    channelId: string,
    payload: DenOutboundPayload,
  ): Promise<DenSendResult> {
    return this.#send("message.send", { channelId, ...payload });
  }

  async updateMessage(
    channelId: string,
    messageId: string,
    payload: DenOutboundPayload,
  ): Promise<void> {
    await this.#send("message.update", {
      channelId,
      messageId,
      ...payload,
    });
  }

  async deleteMessage(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.#send("message.delete", { channelId, messageId });
  }

  async sendBreadcrumb(breadcrumb: DenBreadcrumbPayload): Promise<void> {
    await this.#send("breadcrumb.send", breadcrumb);
  }

  async updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<
      Pick<DenBreadcrumbPayload, "status" | "description">
    >,
  ): Promise<void> {
    await this.#send("breadcrumb.update", {
      id: breadcrumbId,
      ...update,
    });
  }

  on<K extends keyof DenConnectionEvents>(
    event: K,
    listener: DenConnectionEvents[K],
  ): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  // ── Internals ───────────────────────────────────────────────

  #emit<K extends keyof DenConnectionEvents>(
    event: K,
    ...args: Parameters<DenConnectionEvents[K]>
  ): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call
        (listener as any)(...args);
      } catch {
        // listener errors must not crash the connection
      }
    }
  }

  async #connect(): Promise<void> {
    this.#logger.info("Den WebSocket connecting", { url: this.#url });

    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new ConnectionError(
            `Den WebSocket connection timed out after ${String(this.#connectionTimeoutMs)}ms`,
          ),
        );
      }, this.#connectionTimeoutMs);

      ws.onopen = () => {
        clearTimeout(timeout);
        // Authenticate via token in the first message
        this.#authenticate(ws)
          .then(() => {
            this.#opened = true;
            this.#reconnectAttempt = 0;
            this.#startHeartbeat();
            this.#logger.info("Den WebSocket connected");
            this.#emit("connected");
            resolve();
          })
          .catch(reject);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        // onclose will fire next; don't reject here
      };

      ws.onclose = (event) => {
        clearTimeout(timeout);
        if (!this.#opened) {
          reject(
            new ConnectionError(
              `Den WebSocket closed during connect (code ${String(event.code)})`,
            ),
          );
          return;
        }
        this.#handleClose(event);
      };
    });

    ws.onmessage = (event) => {
      this.#handleMessage(event);
    };

    ws.onerror = () => {
      this.#logger.warn("Den WebSocket transport error");
    };
  }

  async #authenticate(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const authTimeout = setTimeout(() => {
        reject(
          new AuthenticationError("Den WebSocket authentication timed out"),
        );
      }, 10_000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (event: any): void => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const data = event.data as string;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          if (msg.type === "auth_ok") {
            clearTimeout(authTimeout);
            ws.removeEventListener("message", handler);
            resolve();
          } else if (msg.type === "auth_error") {
            clearTimeout(authTimeout);
            ws.removeEventListener("message", handler);
            const reasonStr =
              typeof msg.reason === "string" ? msg.reason : "unknown";
            reject(
              new AuthenticationError(
                `Den WebSocket auth rejected: ${reasonStr}`,
              ),
            );
          }
        } catch {
          // not JSON, ignore during auth phase
        }
      };

      ws.addEventListener("message", handler);

      ws.send(
        JSON.stringify({
          type: "auth",
          token: this.#token,
        }),
      );
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #handleMessage(event: any): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const data = event.data as string;
      const raw = JSON.parse(data) as Record<string, unknown>;

      switch (raw.type) {
        case "message": {
          const msg = raw as unknown as DenInboundMessage;
          this.#emit("message", msg);
          break;
        }
        case "ack": {
          break;
        }
        case "pong": {
          break;
        }
        case "error": {
          const errMsg = typeof raw.message === "string" ? raw.message : "unknown";
          this.#logger.error(`Den Gateway error: ${errMsg}`, raw);
          this.#emit("error", new Error(errMsg));
          break;
        }
        default: {
          this.#logger.debug("Unrecognized Den message type", {
            type: raw.type,
          });
          break;
        }
      }
    } catch {
      this.#logger.warn("Failed to parse Den WebSocket message");
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #handleClose(event: any): void {
    this.#opened = false;
    this.#stopHeartbeat();
    this.#ws = null;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const code = event.code as number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const reasonStr = event.reason as string | undefined;
    const reason = `code=${String(code ?? "?")} reason=${reasonStr ?? ""}`;
    this.#logger.warn("Den WebSocket closed", { reason });

    this.#emit("disconnected", reason);

    if (!this.#closed) {
      void this.#startReconnect();
    }
  }

  async #startReconnect(): Promise<void> {
    if (this.#closed || this.#reconnectAttempt >= this.#retryPolicy.maxAttempts) {
      if (!this.#closed) {
        this.#logger.error("Den WebSocket reconnection exhausted");
        this.#emit(
          "connectionFailed",
          new ConnectionError("Den WebSocket reconnection exhausted"),
        );
      }
      return;
    }

    this.#reconnectAttempt++;
    this.#emit("reconnecting", this.#reconnectAttempt, this.#retryPolicy.maxAttempts);

    const delay = Math.min(
      this.#retryPolicy.baseDelayMs *
        2 ** (this.#reconnectAttempt - 1),
      this.#retryPolicy.maxDelayMs,
    );

    this.#logger.info(
      `Den WebSocket reconnecting in ${String(delay)}ms (attempt ${String(this.#reconnectAttempt)}/${String(this.#retryPolicy.maxAttempts)})`,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, delay));

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.#closed) return;

    try {
      await this.#connect();
    } catch {
      // #connect's onclose handler will call #startReconnect again
    }
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#pingTimer = setInterval(() => {
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(JSON.stringify({ type: "ping" }));
      }
    }, this.#pingIntervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  async #send(
    type: string,
    body: Record<string, unknown>,
  ): Promise<DenSendResult> {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionError("Den WebSocket is not connected");
    }

    return new Promise<DenSendResult>((resolve, reject) => {
      const requestId = crypto.randomUUID();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (evt: any): void => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          const rawData = evt.data as string;
          const raw = JSON.parse(rawData) as Record<string, unknown>;
          if (raw.type === "ack" && raw.requestId === requestId) {
            this.#ws?.removeEventListener("message", handler);
            const msgId =
              typeof raw.messageId === "string"
                ? raw.messageId
                : requestId;
            resolve({ id: msgId });
          } else if (raw.type === "error" && raw.requestId === requestId) {
            this.#ws?.removeEventListener("message", handler);
            const errMsg =
              typeof raw.message === "string"
                ? raw.message
                : "request failed";
            reject(new Error(errMsg));
          }
        } catch {
          // not our ack, ignore
        }
      };

      this.#ws.addEventListener("message", handler);

      this.#ws.send(
        JSON.stringify({
          type,
          requestId,
          ...body,
        }),
      );
    });
  }
}

// ── Simulated connection (for testing) ──────────────────────────

/**
 * In-memory {@link DenConnection} that simulates the Den Channels Gateway.
 *
 * Used in unit tests so the adapter and message-format layers can be
 * exercised without a real WebSocket.
 */
export class SimulatedDenConnection implements DenConnection {
  #listeners = new Map<
    keyof DenConnectionEvents,
    Set<DenConnectionEvents[keyof DenConnectionEvents]>
  >();

  #open = false;
  readonly #logger: Logger;

  /** All sent message payloads (for test assertions). */
  public readonly sentMessages: Array<{
    channelId: string;
    payload: DenOutboundPayload;
    result: DenSendResult;
  }> = [];

  /** All message update calls captured. */
  public readonly updatedMessages: Array<{
    channelId: string;
    messageId: string;
    payload: DenOutboundPayload;
  }> = [];

  /** All delete calls captured. */
  public readonly deletedMessages: Array<{
    channelId: string;
    messageId: string;
  }> = [];

  /** All breadcrumb send calls captured. */
  public readonly breadcrumbs: DenBreadcrumbPayload[] = [];

  /** All breadcrumb update calls captured. */
  public readonly breadcrumbUpdates: Array<{
    breadcrumbId: string;
    update: Partial<
      Pick<DenBreadcrumbPayload, "status" | "description">
    >;
  }> = [];

  private currentMessageId = 0;
  private disconnectOnNextSend = false;
  private readonly simulatedLatencyMs: number;

  constructor(
    logger: Logger,
    options?: { simulatedLatencyMs?: number },
  ) {
    this.#logger = logger;
    this.simulatedLatencyMs = options?.simulatedLatencyMs ?? 0;
  }

  // ── Connection lifecycle ────────────────────────────────────

  get isOpen(): boolean {
    return this.#open;
  }

  async open(): Promise<void> {
    if (this.#open) return;
    this.#open = true;
    this.#logger.info("Simulated Den connection opened");
    this.#emit("connected");
    await Promise.resolve();
  }

  async close(): Promise<void> {
    this.#open = false;
    this.#logger.info("Simulated Den connection closed");
    this.#emit("disconnected", "simulated-close");
    await Promise.resolve();
  }

  // ── Messaging ───────────────────────────────────────────────

  async sendMessage(
    channelId: string,
    payload: DenOutboundPayload,
  ): Promise<DenSendResult> {
    this.#checkOpen();
    await this.#simulateLatency();

    if (this.disconnectOnNextSend) {
      this.#open = false;
      this.disconnectOnNextSend = false;
      this.#emit("disconnected", "simulated-disconnect");
      throw new ConnectionError("Simulated disconnect on send");
    }

    this.currentMessageId++;
    const result: DenSendResult = {
      id: `den-msg-${String(this.currentMessageId)}`,
    };
    this.sentMessages.push({ channelId, payload, result });
    return result;
  }

  async updateMessage(
    channelId: string,
    messageId: string,
    payload: DenOutboundPayload,
  ): Promise<void> {
    this.#checkOpen();
    this.updatedMessages.push({ channelId, messageId, payload });
    await Promise.resolve();
  }

  async deleteMessage(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    this.#checkOpen();
    this.deletedMessages.push({ channelId, messageId });
    await Promise.resolve();
  }

  // ── Breadcrumbs ─────────────────────────────────────────────

  async sendBreadcrumb(breadcrumb: DenBreadcrumbPayload): Promise<void> {
    this.#checkOpen();
    this.breadcrumbs.push(breadcrumb);
    await Promise.resolve();
  }

  async updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<
      Pick<DenBreadcrumbPayload, "status" | "description">
    >,
  ): Promise<void> {
    this.#checkOpen();
    this.breadcrumbUpdates.push({ breadcrumbId, update });
    await Promise.resolve();
  }

  // ── Events ──────────────────────────────────────────────────

  on<K extends keyof DenConnectionEvents>(
    event: K,
    listener: DenConnectionEvents[K],
  ): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  // ── Test simulation helpers ─────────────────────────────────

  /**
   * Inject an inbound message as if received from the Den Gateway.
   */
  simulateInboundMessage(msg: DenInboundMessage): void {
    this.#emit("message", msg);
  }

  /**
   * Simulate a connection drop. Triggers `disconnected` event.
   */
  simulateDisconnect(reason?: string): void {
    this.#open = false;
    this.#emit("disconnected", reason ?? "simulated-disconnect");
  }

  /**
   * Cause the next send to fail with a disconnect, useful for
   * testing reconnection flows.
   */
  simulateDisconnectOnNextSend(): void {
    this.disconnectOnNextSend = true;
  }

  /**
   * Clear all captured state.
   */
  clear(): void {
    this.sentMessages.length = 0;
    this.updatedMessages.length = 0;
    this.deletedMessages.length = 0;
    this.breadcrumbs.length = 0;
    this.breadcrumbUpdates.length = 0;
  }

  // ── Internals ───────────────────────────────────────────────

  #emit<K extends keyof DenConnectionEvents>(
    event: K,
    ...args: Parameters<DenConnectionEvents[K]>
  ): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call
        (listener as any)(...args);
      } catch {
        // listener errors must not crash the connection
      }
    }
  }

  #checkOpen(): void {
    if (!this.#open) {
      throw new ConnectionError("Simulated Den connection is not open");
    }
  }

  async #simulateLatency(): Promise<void> {
    if (this.simulatedLatencyMs > 0) {
      await new Promise<void>((r) =>
        setTimeout(r, this.simulatedLatencyMs),
      );
    }
  }
}
