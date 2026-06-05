/**
 * WebSocket-based connection to the Den Channels Gateway.
 *
 * Handles:
 * - WebSocket lifecycle (open / close)
 * - Authentication via token in the initial handshake
 * - Exponential-backoff reconnection on unexpected close
 * - Heartbeat ping/pong to detect stale connections
 *
 * @module pi-channels/den-channels/connection-websocket
 */

import { ConnectionError, AuthenticationError } from "@pi-crew/core";
import type { Logger } from "@pi-crew/core";
import { DEFAULT_RETRY_POLICY } from "@pi-crew/core";
import type { RetryPolicy } from "@pi-crew/core";
import type {
  DenConnection,
  DenConnectionEvents,
  DenInboundMessage,
  DenOutboundPayload,
  DenBreadcrumbPayload,
  DenSendResult,
  DenConnectionConfig,
} from "./connection-types.js";

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
    if (this.#opened) return;

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
