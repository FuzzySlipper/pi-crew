/**
 * HTTP cursor/polling Den Channels direct-agent-events connection.
 *
 * Implements {@link DenConnection} for production use when Den Channels
 * exposes HTTP routes instead of WebSocket.  Polls
 * `GET /api/direct-agent-events` on a configurable interval, persists
 * a cursor so restarts do not replay handled events, maps direct-agent
 * event items into {@link DenInboundMessage}, emits lifecycle telemetry
 * via `POST /api/agent-work/lifecycle-events`, and posts final
 * gateway-delivery evidence via `POST /api/gateway/system-messages`.
 *
 * @module pi-channels/den-channels/connection-http
 */

import type { Logger } from "@pi-crew/core";
import { ConnectionError } from "@pi-crew/core";
import type {
  DenConnection,
  DenConnectionEvents,
  DenHttpConnectionConfig,
  CursorStore,
  DenInboundMessage,
  DenOutboundPayload,
  DenBreadcrumbPayload,
  DenSendResult,
} from "./connection-types.js";

// ── Direct-agent event wire shape ───────────────────────────────

/**
 * Shape of an item returned by `GET /api/direct-agent-events`.
 *
 * Only the fields we consume are modelled; the actual response may
 * carry additional metadata.
 */
interface DirectAgentEventItem {
  readonly id: number;
  readonly channelId: number;
  readonly memberIdentity: string;
  readonly sourceProjectId?: string | null;
  readonly targetProjectId?: string | null;
  readonly targetTaskId?: unknown;
  readonly assignmentId?: string | null;
  readonly workerRunId?: string | null;
  readonly workerRole?: string | null;
  readonly body?: string | null;
  readonly status?: string | null;
  readonly createdAt?: string | null;
}

/**
 * Shape of the JSON array returned by the cursor endpoint.
 */
type DirectAgentEventResponse = DirectAgentEventItem[];

// ── Lifecycle telemetry wire ────────────────────────────────────

interface LifecycleEventPayload {
  readonly eventType: string;
  readonly sourceRequestId: number;
  readonly memberIdentity: string;
  readonly targetProjectId?: string | null;
  readonly targetTaskId?: unknown;
  readonly assignmentId?: string | null;
  readonly workerRunId?: string | null;
  readonly workerRole?: string | null;
  readonly timestamp: string;
}

// ── Gateway system-message wire ─────────────────────────────────

interface GatewaySystemMessagePayload {
  readonly channelId: number;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly body: string;
  readonly memberIdentity: string;
}

// ── Poll state ──────────────────────────────────────────────────

interface PollState {
  /** `setInterval` handle; `null` when not polling. */
  timer: ReturnType<typeof setInterval> | null;
  /** True when a poll iteration is in-flight (prevents overlap). */
  inFlight: boolean;
  /** AbortController for clean shutdown. */
  controller: AbortController;
}

// ── Constructor options ─────────────────────────────────────────

export interface DenHttpConnectionOptions {
  /**
   * Injected `fetch` implementation.
   *
   * Defaults to the global `fetch` binding.  Override in tests to
   * provide a mock without hitting a live server.
   */
  readonly fetchFn?: typeof fetch;
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_LIMIT = 10;
const DEFAULT_CURSOR_KEY = "den_channels_cursor";
const FETCH_TIMEOUT_MS = 15_000;

// ── Connection implementation ───────────────────────────────────

/**
 * HTTP cursor/polling {@link DenConnection} for Den Channels
 * direct-agent-events.
 *
 * ## Lifecycle
 *
 * 1. **open()** — reads the persisted cursor, fires `connected`, and
 *    starts the polling loop.
 * 2. **Polling loop** — every `pollIntervalMs`, fetches new events
 *    since the last cursor, maps each to a {@link DenInboundMessage},
 *    emits `message`, persists the cursor, posts lifecycle telemetry,
 *    and posts a gateway-delivery response.
 * 3. **close()** — stops the polling loop, persists the cursor, fires
 *    `disconnected`.
 *
 * ## Outbound messaging
 *
 * {@link sendMessage} posts via `POST /api/gateway/system-messages`
 * with `sourceKind=gateway_delivery`.  Other outbound operations
 * (`updateMessage`, `deleteMessage`, `sendBreadcrumb`) are logged
 * and no-oped — the HTTP adapter is an ingress-first transport.
 */
export class DenHttpDirectAgentConnection implements DenConnection {
  readonly #config: DenHttpConnectionConfig;
  readonly #logger: Logger;
  readonly #cursorStore: CursorStore;
  readonly #fetchFn: typeof fetch;

  readonly #listeners = new Map<
    keyof DenConnectionEvents,
    Set<DenConnectionEvents[keyof DenConnectionEvents]>
  >();

  #open = false;
  #lastCursor: number | null = null;
  #pollState: PollState = {
    timer: null,
    inFlight: false,
    controller: new AbortController(),
  };

  constructor(
    config: DenHttpConnectionConfig,
    logger: Logger,
    cursorStore: CursorStore,
    options?: DenHttpConnectionOptions,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#cursorStore = cursorStore;
    this.#fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  // ── Connection lifecycle ──────────────────────────────────────

  get isOpen(): boolean {
    return this.#open;
  }

  async open(): Promise<void> {
    if (this.#open) return;

    // Restore persisted cursor.
    const key = this.#config.cursorPersistenceKey ?? DEFAULT_CURSOR_KEY;
    const raw = await this.#cursorStore.read(key);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        this.#lastCursor = parsed;
        this.#logger.info("Restored Den Channels event cursor", {
          key,
          cursor: parsed,
        });
      }
    }

    // Fire connected so the adapter can wire listeners.
    this.#open = true;
    this.#emit("connected");

    // Start polling.
    const interval = this.#config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#pollState.timer = setInterval(() => {
      void this.#poll();
    }, interval);

    // Run first poll immediately.
    void this.#poll();

    this.#logger.info("Den HTTP direct-agent connection opened", {
      baseUrl: this.#config.baseUrl,
      projectId: this.#config.projectId,
      pollIntervalMs: interval,
      cursor: this.#lastCursor,
    });
  }

  async close(): Promise<void> {
    if (!this.#open) return;

    // Stop polling.
    if (this.#pollState.timer !== null) {
      clearInterval(this.#pollState.timer);
      this.#pollState.timer = null;
    }
    this.#pollState.controller.abort();

    // Persist final cursor.
    await this.#persistCursor();

    this.#open = false;
    this.#emit("disconnected", "http-close");
    this.#logger.info("Den HTTP direct-agent connection closed");
  }

  // ── Outbound messaging ────────────────────────────────────────

  async sendMessage(
    channelId: string,
    payload: DenOutboundPayload,
  ): Promise<DenSendResult> {
    // The HTTP adapter sends gateway-delivery system-messages.
    const text = denContentToText(payload.content);
    await this.#postGatewaySystemMessage(
      Number(channelId),
      "gateway_delivery",
      text,
    );
    // Return a synthetic result — the gateway_delivery endpoint
    // does not return a message ID.
    const result: DenSendResult = {
      id: `http-delivery-${String(Date.now())}`,
    };
    return result;
  }

  async updateMessage(
    channelId: string,
    messageId: string,
    _payload: DenOutboundPayload,
  ): Promise<void> {
    void _payload; // unused in HTTP mode
    this.#logger.debug("HTTP connection: updateMessage no-op", {
      channelId,
      messageId,
    });
    await Promise.resolve();
  }

  async deleteMessage(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    this.#logger.debug("HTTP connection: deleteMessage no-op", {
      channelId,
      messageId,
    });
    await Promise.resolve();
  }

  async sendBreadcrumb(breadcrumb: DenBreadcrumbPayload): Promise<void> {
    this.#logger.debug("HTTP connection: sendBreadcrumb no-op", {
      breadcrumbId: breadcrumb.id,
    });
    await Promise.resolve();
  }

  async updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<
      Pick<DenBreadcrumbPayload, "status" | "description">
    >,
  ): Promise<void> {
    this.#logger.debug("HTTP connection: updateBreadcrumb no-op", {
      breadcrumbId,
      update,
    });
    await Promise.resolve();
  }

  // ── Events ────────────────────────────────────────────────────

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

  // ── Polling internals ─────────────────────────────────────────

  async #poll(): Promise<void> {
    if (this.#pollState.inFlight) return; // prevent overlap
    if (!this.#open) return;

    this.#pollState.inFlight = true;
    try {
      // Build the cursor URL.
      const baseUrl = this.#config.baseUrl.replace(/\/+$/, "");
      const limit = this.#config.pollLimit ?? DEFAULT_POLL_LIMIT;
      let url = `${baseUrl}/api/direct-agent-events?projectId=${encodeURIComponent(this.#config.projectId)}&limit=${String(limit)}`;
      if (this.#lastCursor !== null) {
        url += `&afterId=${String(this.#lastCursor)}`;
      }

      this.#logger.debug("Polling direct-agent events", { url });

      const response = await this.#fetchWithTimeout(url, {
        method: "GET",
        headers: this.#authHeaders(),
        signal: this.#pollState.controller.signal,
      });

      if (!response.ok) {
        this.#logger.warn("Direct-agent events poll returned non-OK", {
          status: response.status,
          statusText: response.statusText,
        });
        return;
      }

      const items = (await response.json()) as DirectAgentEventResponse;
      if (!Array.isArray(items)) {
        this.#logger.warn("Unexpected direct-agent-events response shape");
        return;
      }

      this.#logger.debug("Poll returned events", { count: items.length });

      // Process each event in order so cursor advances monotonically.
      for (const item of items) {
        await this.#handleEvent(item);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Expected during shutdown — not an error.
        return;
      }
      this.#logger.error("Poll iteration failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.#emit("error", new ConnectionError(
        err instanceof Error ? err.message : String(err),
      ));
    } finally {
      this.#pollState.inFlight = false;
    }
  }

  async #handleEvent(item: DirectAgentEventItem): Promise<void> {
    const eventId = item.id;

    // 1. Emit lifecycle: runtime_received
    await this.#postLifecycleEvent("runtime_received", eventId, item);

    // 2. Map event → DenInboundMessage and fire `message` event
    const inbound = this.#mapEventToMessage(item);
    this.#emit("message", inbound);

    // 3. Emit lifecycle: request_claimed
    await this.#postLifecycleEvent("request_claimed", eventId, item);

    // 4. Post gateway_delivery echo/response
    await this.#postGatewayDeliveryResponse(item);

    // 5. Emit lifecycle: turn_completed
    await this.#postLifecycleEvent("turn_completed", eventId, item);

    // 6. Advance cursor *after* the event has been fully handled.
    this.#lastCursor = eventId;
  }

  // ── Event → DenInboundMessage mapping ─────────────────────────

  #mapEventToMessage(item: DirectAgentEventItem): DenInboundMessage {
    const body = item.body ?? "";
    return {
      id: String(item.id),
      channelId: String(item.channelId),
      sender: {
        id: "den-system",
        displayName: "Den Channels",
        kind: "system",
      },
      content: { kind: "text", text: body },
      timestamp: item.createdAt ?? new Date().toISOString(),
      metadata: {
        sourceProjectId: item.sourceProjectId,
        targetProjectId: item.targetProjectId,
        targetTaskId: item.targetTaskId,
        assignmentId: item.assignmentId,
        workerRunId: item.workerRunId,
        workerRole: item.workerRole,
        status: item.status,
        eventId: item.id,
        eventKind: "direct-agent-event",
      },
    };
  }

  // ── Lifecycle telemetry ───────────────────────────────────────

  async #postLifecycleEvent(
    eventType: string,
    sourceRequestId: number,
    item: DirectAgentEventItem,
  ): Promise<void> {
    const baseUrl = this.#config.baseUrl.replace(/\/+$/, "");
    const payload: LifecycleEventPayload = {
      eventType,
      sourceRequestId,
      memberIdentity: this.#config.memberIdentity,
      targetProjectId: item.targetProjectId,
      targetTaskId: item.targetTaskId,
      assignmentId: item.assignmentId,
      workerRunId: item.workerRunId,
      workerRole: item.workerRole,
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await this.#fetchWithTimeout(
        `${baseUrl}/api/agent-work/lifecycle-events`,
        {
          method: "POST",
          headers: {
            ...this.#authHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: this.#pollState.controller.signal,
        },
      );

      if (!response.ok) {
        this.#logger.warn("Lifecycle event POST returned non-OK", {
          eventType,
          status: response.status,
        });
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      this.#logger.warn("Lifecycle event POST failed", {
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Gateway delivery ──────────────────────────────────────────

  async #postGatewayDeliveryResponse(
    item: DirectAgentEventItem,
  ): Promise<void> {
    const body = item.body ?? "";
    await this.#postGatewaySystemMessage(
      item.channelId,
      "gateway_delivery",
      body,
    );
  }

  async #postGatewaySystemMessage(
    channelId: number,
    sourceKind: string,
    body: string,
  ): Promise<void> {
    const baseUrl = this.#config.baseUrl.replace(/\/+$/, "");
    const payload: GatewaySystemMessagePayload = {
      channelId,
      sourceKind,
      sourceId: `http-connection-${String(Date.now())}`,
      body,
      memberIdentity: this.#config.memberIdentity,
    };

    try {
      const response = await this.#fetchWithTimeout(
        `${baseUrl}/api/gateway/system-messages`,
        {
          method: "POST",
          headers: {
            ...this.#authHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: this.#pollState.controller.signal,
        },
      );

      if (!response.ok) {
        this.#logger.warn("Gateway system-message POST returned non-OK", {
          sourceKind,
          status: response.status,
        });
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      this.#logger.warn("Gateway system-message POST failed", {
        sourceKind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Cursor persistence ────────────────────────────────────────

  async #persistCursor(): Promise<void> {
    if (this.#lastCursor === null) return;
    const key = this.#config.cursorPersistenceKey ?? DEFAULT_CURSOR_KEY;
    try {
      await this.#cursorStore.write(key, String(this.#lastCursor));
    } catch (err: unknown) {
      this.#logger.warn("Failed to persist cursor", {
        key,
        cursor: this.#lastCursor,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────

  #authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#config.token.length > 0) {
      headers["Authorization"] = `Bearer ${this.#config.token}`;
    }
    return headers;
  }

  async #fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    // Merge the caller's signal with our timeout signal.
    const combinedSignal = init.signal
      ? anySignal([init.signal, controller.signal])
      : controller.signal;

    try {
      const response = await this.#fetchFn(url, {
        ...init,
        signal: combinedSignal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Event emitter ─────────────────────────────────────────────

  #emit<K extends keyof DenConnectionEvents>(
    event: K,
    ...args: Parameters<DenConnectionEvents[K]>
  ): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        Reflect.apply(
          listener as (...a: unknown[]) => void,
          undefined,
          args,
        );
      } catch {
        // Listener errors must not crash the connection.
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function denContentToText(content: DenInboundMessage["content"]): string {
  switch (content.kind) {
    case "text":
      return content.text;
    case "media":
      return content.altText ?? content.url;
    case "mixed":
      return content.parts.map(denContentToText).join(" ");
  }
}

/**
 * Combine multiple AbortSignals with "any" semantics.
 *
 * When any signal aborts, the combined signal aborts with
 * the same reason.  Falls back to a single signal when only
 * one is provided.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 0) {
    return new AbortController().signal;
  }
  if (signals.length === 1 && signals[0] !== undefined) {
    return signals[0];
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}
