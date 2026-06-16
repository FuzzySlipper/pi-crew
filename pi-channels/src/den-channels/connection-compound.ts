/**
 * Compound Den connection — merges events from multiple project-scoped
 * DenConnections into a single DenConnection interface.
 *
 * Polling is multi-project: each inner connection polls its own project's
 * events.  Sending uses the primary connection — the Den Channels send API
 * is project-agnostic.
 *
 * @module pi-channels/den-channels/connection-compound
 */

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
 * Compound DenConnection that wraps a primary connection plus additional
 * project-scoped connections.  Events from all connections are forwarded
 * to subscribers; sends go through the primary connection.
 */
export class CompoundDenConnection implements DenConnection {
  readonly #primary: DenConnection;
  readonly #additional: readonly DenConnection[];
  readonly #logger: Logger;
  readonly #listeners = new Map<
    keyof DenConnectionEvents,
    Set<(...args: unknown[]) => void>
  >();
  readonly #unsubscribers: readonly (() => void)[];

  constructor(
    primary: DenConnection,
    additional: readonly DenConnection[],
    logger: Logger,
  ) {
    this.#primary = primary;
    this.#additional = additional;
    this.#logger = logger;
    this.#unsubscribers = [primary, ...additional].flatMap((conn) =>
      (Object.keys(EVENT_NAMES) as (keyof DenConnectionEvents)[]).map((event) =>
        conn.on(event, (...args) => {
          const set = this.#listeners.get(event);
          if (set === undefined) return;
          for (const listener of set) {
            try {
              (listener as (...a: unknown[]) => void)(...args);
            } catch (err: unknown) {
              this.#logger.warn("CompoundDenConnection listener threw", {
                event,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }),
      ),
    );
  }

  get isOpen(): boolean {
    return this.#primary.isOpen;
  }

  async open(): Promise<void> {
    await this.#primary.open();
    await Promise.all(this.#additional.map((conn) => conn.open()));
    this.#logger.info("CompoundDenConnection opened", {
      connectionCount: 1 + this.#additional.length,
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.#additional.map((conn) => conn.close()));
    await this.#primary.close();
  }

  async sendMessage(
    channelId: string,
    payload: DenOutboundPayload,
  ): Promise<DenSendResult> {
    return this.#primary.sendMessage(channelId, payload);
  }

  async updateMessage(
    channelId: string,
    messageId: string,
    payload: DenOutboundPayload,
  ): Promise<void> {
    return this.#primary.updateMessage(channelId, messageId, payload);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    return this.#primary.deleteMessage(channelId, messageId);
  }

  async sendBreadcrumb(breadcrumb: DenBreadcrumbPayload): Promise<void> {
    await this.#primary.sendBreadcrumb(breadcrumb);
    await Promise.all(
      this.#additional.map((conn) => conn.sendBreadcrumb(breadcrumb).catch(() => { /* best-effort */ })),
    );
  }

  async updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<Pick<DenBreadcrumbPayload, "status" | "description">>,
  ): Promise<void> {
    await this.#primary.updateBreadcrumb(breadcrumbId, update);
    await Promise.all(
      this.#additional.map((conn) =>
        conn.updateBreadcrumb(breadcrumbId, update).catch(() => { /* best-effort */ }),
      ),
    );
  }

  on<K extends keyof DenConnectionEvents>(
    event: K,
    listener: DenConnectionEvents[K],
  ): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as (...args: unknown[]) => void);
    return () => {
      set!.delete(listener as (...args: unknown[]) => void);
    };
  }
}

const EVENT_NAMES: Record<string, true> = {
  connected: true,
  disconnected: true,
  reconnecting: true,
  connectionFailed: true,
  message: true,
  error: true,
};
