/**
 * In-memory simulated Den Channels Gateway connection for testing.
 *
 * Implements {@link DenConnection} for unit tests.
 *
 * @module pi-channels/den-channels/connection-simulated
 */

import { ConnectionError } from "@pi-crew/core";
import type { Logger } from "@pi-crew/core";
import type {
  DenConnection,
  DenConnectionEvents,
  DenInboundMessage,
  DenOutboundPayload,
  DenBreadcrumbPayload,
  DenSendResult,
} from "./connection-types.js";

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
   * Simulate a transport/protocol error. Triggers `error` event.
   */
  simulateError(error: Error): void {
    this.#emit("error", error);
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
        Reflect.apply(listener as (...a: unknown[]) => void, undefined, args);
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
