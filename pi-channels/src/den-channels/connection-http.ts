import type {
  ChannelMembership,
  ChannelMembershipUpsert,
  ChannelPresence,
  ChannelPresenceQuery,
  ChannelSubscription,
  ChannelSubscriptionRelease,
  ChannelSubscriptionStatusUpdate,
  ChannelSubscriptionUpsert,
  Logger,
} from "@pi-crew/core";
import { ConnectionError } from "@pi-crew/core";
import {
  HttpDirectAgentClient,
  type DirectAgentEventItem,
  type HttpDirectAgentClientOptions,
} from "./connection-http-client.js";
import { HttpSubscriptionClient } from "./connection-http-subscription-client.js";
import {
  type ActiveSubscriptionState,
  cursorJsonForEvent,
  readSubscriptionMessageCursor,
  selectActiveSubscription,
  subscriptionMetadata,
} from "./connection-http-subscription-state.js";
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
interface PollState {
  readonly controller: AbortController;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
}
export interface DenHttpConnectionOptions extends HttpDirectAgentClientOptions {}
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_LIMIT = 10;
const DEFAULT_CURSOR_KEY = "den_channels_cursor";
/**
 * HTTP cursor/polling {@link DenConnection} for Den Channels
 * direct-agent-events.
 *
 * `open()` restores the durable cursor, fires `connected`, and starts
 * polling. Each event is mapped to an inbound message, telemetry is emitted,
 * gateway-delivery evidence is posted, then the cursor advances. `close()`
 * stops polling and persists the final cursor.
 */
export class DenHttpDirectAgentConnection implements DenConnection {
  readonly #config: DenHttpConnectionConfig;
  readonly #logger: Logger;
  readonly #cursorStore: CursorStore;
  readonly #client: HttpDirectAgentClient;
  readonly #subscriptionClient: HttpSubscriptionClient;
  readonly #listeners = new Map<
    keyof DenConnectionEvents,
    Set<DenConnectionEvents[keyof DenConnectionEvents]>
  >();
  #open = false;
  #lastCursor: number | null = null;
  #activeSubscription: ActiveSubscriptionState | null = null;
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
    this.#client = new HttpDirectAgentClient(config, logger, options);
    this.#subscriptionClient = new HttpSubscriptionClient(config, logger, options);
  }
  get isOpen(): boolean {
    return this.#open;
  }
  async open(): Promise<void> {
    if (this.#open) return;
    await this.#restoreCursor();
    await this.#registerSubscription();
    this.#open = true;
    this.#emit("connected");
    const interval = this.#config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#pollState.timer = setInterval(() => {
      void this.#poll();
    }, interval);
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
    if (this.#pollState.timer !== null) {
      clearInterval(this.#pollState.timer);
      this.#pollState.timer = null;
    }
    await this.#releaseSubscription();
    this.#pollState.controller.abort();
    await this.#persistCursor();
    this.#open = false;
    this.#emit("disconnected", "http-close");
    this.#logger.info("Den HTTP direct-agent connection closed");
  }
  async sendMessage(channelId: string, payload: DenOutboundPayload): Promise<DenSendResult> {
    const text = denContentToText(payload.content);
    const sourceId = `http-delivery-${String(Date.now())}`;
    await this.#client.postGatewaySystemMessage(
      Number(channelId),
      "gateway_delivery",
      sourceId,
      text,
      senderIdentityFromMetadata(payload.metadata) ?? this.#config.memberIdentity,
      this.#pollState.controller.signal,
    );
    return { id: sourceId };
  }
  async updateMessage(
    channelId: string,
    messageId: string,
    _payload: DenOutboundPayload,
  ): Promise<void> {
    void _payload;
    this.#logger.debug("HTTP connection: updateMessage no-op", {
      channelId,
      messageId,
    });
    await Promise.resolve();
  }
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
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
    update: Partial<Pick<DenBreadcrumbPayload, "status" | "description">>,
  ): Promise<void> {
    this.#logger.debug("HTTP connection: updateBreadcrumb no-op", {
      breadcrumbId,
      update,
    });
    await Promise.resolve();
  }
  on<K extends keyof DenConnectionEvents>(event: K, listener: DenConnectionEvents[K]): () => void {
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
  async upsertMembership(input: ChannelMembershipUpsert): Promise<ChannelMembership> {
    return this.#subscriptionClient.upsertMembership(input, this.#pollState.controller.signal);
  }
  async upsertSubscription(input: ChannelSubscriptionUpsert): Promise<ChannelSubscription> {
    if (this.#config.allowLegacyDirectPolling) return { ...input,
      subscriptionId: `${input.channelId}:${input.subscriptionIdentity}`, status: input.status ?? "active", updatedAt: new Date() };
    return this.#subscriptionClient.upsertSubscription(input, this.#pollState.controller.signal);
  }
  async releaseSubscription(input: ChannelSubscriptionRelease): Promise<void> {
    if (this.#config.allowLegacyDirectPolling) return;
    await this.#subscriptionClient.releaseSubscription(input, this.#pollState.controller.signal);
  }
  async getPresence(input: ChannelPresenceQuery): Promise<readonly ChannelPresence[]> {
    return this.#subscriptionClient.getPresence(input, this.#pollState.controller.signal);
  }
  async updateSubscriptionStatus(input: ChannelSubscriptionStatusUpdate): Promise<void> {
    if (this.#config.allowLegacyDirectPolling) return;
    await this.#subscriptionClient.updateSubscriptionStatus(
      input,
      this.#pollState.controller.signal,
    );
  }

  async #registerSubscription(): Promise<void> {
    if (this.#config.allowLegacyDirectPolling) {
      this.#logger.info("Den HTTP direct-agent connection using current cursor mode", { projectId: this.#config.projectId });
      return;
    }
    try {
      const result = await this.#subscriptionClient.register(this.#pollState.controller.signal);
      const readback = await this.#subscriptionClient.readSubscriptions(
        this.#pollState.controller.signal,
      );
      this.#activeSubscription = selectActiveSubscription(
        this.#config,
        readback.subscriptions,
        result.membershipId,
      );
      if (this.#activeSubscription === null) {
        throw new ConnectionError(
          "Registered subscription was not discoverable in channel-subscriptions readback",
        );
      }
      const cursors = await this.#subscriptionClient.listSubscriptionCursors(
        this.#activeSubscription.subscriptionId,
        this.#pollState.controller.signal,
      );
      const cursor = readSubscriptionMessageCursor(cursors);
      if (cursor !== null) {
        this.#lastCursor = cursor;
        await this.#persistCursor();
      }
      this.#logger.info("Den HTTP subscription cursor ready", {
        subscriptionId: this.#activeSubscription.subscriptionId,
        channelId: this.#activeSubscription.channelId,
        cursor: this.#lastCursor,
      });
    } catch (err: unknown) {
      if (!this.#config.allowLegacyDirectPolling) throw err;
      this.#activeSubscription = null;
      this.#logger.warn(
        "Subscription registration failed; using explicit legacy polling fallback",
        {
          error: errorMessage(err),
        },
      );
    }
  }
  async #releaseSubscription(): Promise<void> {
    if (this.#config.allowLegacyDirectPolling) return;
    try {
      await this.#subscriptionClient.release(this.#pollState.controller.signal);
    } catch (err: unknown) {
      this.#logger.warn("Subscription release failed", { error: errorMessage(err) });
    }
  }

  async #poll(): Promise<void> {
    if (this.#pollState.inFlight || !this.#open) return;

    this.#pollState.inFlight = true;
    try {
      const items = await this.#client.listEvents(
        this.#lastCursor,
        this.#config.pollLimit ?? DEFAULT_POLL_LIMIT,
        this.#pollState.controller.signal,
        this.#activeSubscription?.channelId,
      );
      this.#logger.debug("Poll returned events", { count: items.length });

      for (const item of items) {
        if (this.#shouldProcessEvent(item)) {
          await this.#handleEvent(item);
        }
        await this.#advanceCursor(item);
      }
    } catch (err: unknown) {
      if (isAbortError(err)) return;
      const message = errorMessage(err);
      this.#logger.error("Poll iteration failed", { error: message });
      this.#emit("error", new ConnectionError(message));
    } finally {
      this.#pollState.inFlight = false;
    }
  }

  async #handleEvent(item: DirectAgentEventItem): Promise<void> {
    const eventId = item.id;
    const eventItem =
      (await this.#client.readEvent(eventId, this.#pollState.controller.signal)) ?? item;
    const senderIdentity = targetMemberIdentity(eventItem) ?? this.#config.memberIdentity;
    this.#logger.info("Handling Den HTTP direct-agent event", {
      eventId,
      channelId: eventItem.channelId,
      targetProjectId: eventItem.targetProjectId,
      targetTaskId: eventItem.targetTaskId,
    });
    await this.#client.postLifecycleEvent(
      "runtime_received",
      eventId,
      eventItem,
      senderIdentity,
      this.#pollState.controller.signal,
    );
    await this.#client.postLifecycleEvent(
      "request_claimed",
      eventId,
      eventItem,
      senderIdentity,
      this.#pollState.controller.signal,
    );
    await this.#client.postLifecycleEvent(
      "agent_turn_started",
      eventId,
      eventItem,
      senderIdentity,
      this.#pollState.controller.signal,
    );
    await this.#client.postLifecycleEvent(
      "heartbeat",
      eventId,
      eventItem,
      senderIdentity,
      this.#pollState.controller.signal,
    );

    this.#emit("message", this.#mapEventToMessage(eventItem));

    await this.#client.postLifecycleEvent(
      "completed",
      eventId,
      eventItem,
      senderIdentity,
      this.#pollState.controller.signal,
    );
  }

  #shouldProcessEvent(item: DirectAgentEventItem): boolean {
    const sourceKind = item.sourceKind ?? "wake_event";
    const isWake = sourceKind === "wake_event";
    const isGatewayIngress = sourceKind === "gateway_delivery" && isIngressIntent(item.intent);
    if (!isWake && !isGatewayIngress) return false;
    const target = targetMemberIdentity(item);
    return (
      target !== null &&
      [this.#config.memberIdentity, ...(this.#config.memberIdentities ?? [])].includes(target)
    );
  }
  #mapEventToMessage(item: DirectAgentEventItem): DenInboundMessage {
    return {
      id: String(item.id),
      channelId: String(item.channelId),
      sender: {
        id: "den-system",
        displayName: "Den Channels",
        kind: "system",
      },
      content: { kind: "text", text: item.body ?? "" },
      timestamp: item.createdAt ?? new Date().toISOString(),
      metadata: {
        ...(this.#activeSubscription === null
          ? {}
          : subscriptionMetadata(this.#activeSubscription)),
        sourceProjectId: item.sourceProjectId,
        targetProjectId: item.targetProjectId,
        targetTaskId: item.targetTaskId,
        assignmentId: item.assignmentId,
        workerRunId: item.workerRunId,
        workerRole: item.workerRole,
        memberIdentity: item.memberIdentity,
        targetMemberIdentity: item.targetMemberIdentity,
        profileIdentity: item.profileIdentity,
        agentInstanceId: item.agentInstanceId,
        sessionOwnerId: item.sessionOwnerId,
        sessionId: item.sessionId,
        deliveryStatus: item.deliveryStatus,
        claimStatus: item.claimStatus,
        completionStatus: item.completionStatus,
        intent: item.intent,
        status: item.status,
        eventId: item.id,
        eventKind: "direct-agent-event",
      },
    };
  }

  async #advanceCursor(item: DirectAgentEventItem): Promise<void> {
    this.#lastCursor = item.id;
    if (this.#activeSubscription !== null) {
      try {
        await this.#subscriptionClient.upsertSubscriptionCursor(
          this.#activeSubscription.subscriptionId,
          item.id,
          cursorJsonForEvent(this.#config, this.#activeSubscription, item),
          this.#pollState.controller.signal,
        );
      } catch (err: unknown) {
        if (isAbortError(err)) return;
        this.#logger.warn("Failed to advance subscription cursor", {
          subscriptionId: this.#activeSubscription.subscriptionId,
          cursor: item.id,
          error: errorMessage(err),
        });
        if (!this.#config.allowLegacyDirectPolling) throw err;
      }
    }
    await this.#persistCursor();
  }

  async #restoreCursor(): Promise<void> {
    const key = this.#config.cursorPersistenceKey ?? DEFAULT_CURSOR_KEY;
    const raw = await this.#cursorStore.read(key);
    if (raw === null) return;

    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      this.#lastCursor = parsed;
      this.#logger.info("Restored Den Channels event cursor", {
        key,
        cursor: parsed,
      });
    }
  }

  async #persistCursor(): Promise<void> {
    if (this.#lastCursor === null) return;
    const key = this.#config.cursorPersistenceKey ?? DEFAULT_CURSOR_KEY;
    try {
      await this.#cursorStore.write(key, String(this.#lastCursor));
    } catch (err: unknown) {
      this.#logger.warn("Failed to persist cursor", {
        key,
        cursor: this.#lastCursor,
        error: errorMessage(err),
      });
    }
  }

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
        // Listener errors must not crash the connection.
      }
    }
  }
}

function isIngressIntent(value: unknown): boolean {
  return value === "steer" || value === "follow_up";
}

function targetMemberIdentity(item: DirectAgentEventItem): string | null {
  if (typeof item.targetMemberIdentity === "string" && item.targetMemberIdentity.length > 0)
    return item.targetMemberIdentity;
  if (typeof item.memberIdentity === "string" && item.memberIdentity.length > 0) {
    return item.memberIdentity;
  }
  const sourceId = item.sourceId;
  if (typeof sourceId !== "string") return null;
  const parts = sourceId.split(":");
  if (parts.length < 4 || parts[0] !== "direct-agent-message") return null;
  const encoded = parts[2];
  if (encoded === undefined || encoded.length === 0) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
function senderIdentityFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.["senderIdentity"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

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

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
