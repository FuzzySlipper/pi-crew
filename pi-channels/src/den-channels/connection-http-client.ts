/**
 * HTTP client helpers for Den Channels direct-agent-events.
 *
 * Keeps wire-level fetch/auth/timeout behavior out of the connection class
 * so the connection remains focused on DenConnection lifecycle semantics.
 *
 * @module pi-channels/den-channels/connection-http-client
 */

import { ConnectionError, type Logger } from "@pi-crew/core";

import type { DenHttpConnectionConfig } from "./connection-types.js";

export interface DirectAgentEventItem {
  readonly id: number;
  readonly channelId: number;
  readonly memberIdentity?: string | null;
  readonly sourceKind?: string | null;
  readonly sourceId?: string | null;
  readonly sourceProjectId?: string | null;
  readonly targetProjectId?: string | null;
  readonly targetTaskId?: unknown;
  readonly assignmentId?: string | null;
  readonly workerRunId?: string | null;
  readonly workerRole?: string | null;
  readonly profileIdentity?: string | null;
  readonly agentInstanceId?: string | null;
  readonly poolMemberId?: string | null;
  readonly sessionOwnerId?: string | null;
  readonly sessionId?: string | null;
  readonly deliveryStatus?: string | null;
  readonly claimStatus?: string | null;
  readonly completionStatus?: string | null;
  readonly body?: string | null;
  readonly status?: string | null;
  readonly createdAt?: string | null;
}

interface DirectAgentEventListResponse {
  readonly items: readonly DirectAgentEventItem[];
  readonly nextAfterId?: number | null;
  readonly hasMore?: boolean;
}

interface LifecycleEventPayload {
  readonly channelId: number;
  readonly agentIdentity: string;
  readonly eventType: string;
  readonly projectId?: string | null;
  readonly taskId?: number | null;
  readonly assignmentId?: string | null;
  readonly workerRunId?: string | null;
  readonly workerRole?: string | null;
  readonly profileIdentity?: string | null;
  readonly agentInstanceId?: string | null;
  readonly poolMemberId?: string | null;
  readonly sessionId?: string | null;
  readonly sourceMessageId: string;
  readonly directAgentEventId: string;
  readonly lastActivityAt: string;
  readonly stalenessDeadline?: string;
  readonly summary: string;
}

interface LegacyLifecycleActivityPayload {
  readonly channelId: number;
  readonly projectId?: string | null;
  readonly agentIdentity: string;
  readonly deliveryRequestId: string;
  readonly workerRunId?: string | null;
  readonly workerRole?: string | null;
  readonly taskId?: number | null;
  readonly assignmentId?: string | null;
  readonly eventType: "lifecycle_status";
  readonly status: string;
  readonly deliveryStage: "observability";
  readonly terminal: boolean;
  readonly summary: string;
  readonly metadataJson: string;
  readonly dedupeKey: string;
}

interface GatewaySystemMessagePayload {
  readonly channelId: number;
  readonly senderIdentity: string;
  readonly messageKind: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly body: string;
  readonly deliveryRequestId: string;
  readonly dedupeKey: string;
}

export interface HttpDirectAgentClientOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_LIFECYCLE_STALENESS_MS = 60_000;

export class HttpDirectAgentClient {
  readonly #config: DenHttpConnectionConfig;
  readonly #logger: Logger;
  readonly #fetchFn: typeof fetch;
  readonly #timeoutMs: number;

  constructor(
    config: DenHttpConnectionConfig,
    logger: Logger,
    options?: HttpDirectAgentClientOptions,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async listEvents(
    cursor: number | null,
    limit: number,
    signal: AbortSignal,
    channelId?: string,
  ): Promise<DirectAgentEventItem[]> {
    const url = this.#directAgentEventsUrl(cursor, limit, channelId);
    this.#logger.debug("Polling direct-agent events", { url });

    const response = await this.#fetchWithTimeout(url, {
      method: "GET",
      headers: this.#authHeaders(),
      signal,
    });

    if (!response.ok) {
      this.#logger.warn("Direct-agent events poll returned non-OK", {
        status: response.status,
        statusText: response.statusText,
      });
      return [];
    }

    const payload: unknown = await response.json();
    if (isDirectAgentEventItemArray(payload)) {
      return payload;
    }
    if (isDirectAgentEventListResponse(payload)) {
      return [...payload.items];
    }

    this.#logger.warn("Unexpected direct-agent-events response shape");
    return [];
  }

  async postLifecycleEvent(
    eventType: string,
    sourceRequestId: number,
    item: DirectAgentEventItem,
    signal: AbortSignal,
  ): Promise<void> {
    const lastActivityAt = new Date();
    const payload: LifecycleEventPayload = {
      channelId: item.channelId,
      agentIdentity: this.#config.memberIdentity,
      eventType,
      projectId: item.targetProjectId ?? item.sourceProjectId,
      taskId: parseOptionalLong(item.targetTaskId),
      assignmentId: item.assignmentId,
      workerRunId: item.workerRunId,
      workerRole: item.workerRole,
      profileIdentity: item.profileIdentity,
      agentInstanceId: item.agentInstanceId,
      poolMemberId: item.poolMemberId,
      sessionId: item.sessionId,
      sourceMessageId: String(sourceRequestId),
      directAgentEventId: String(sourceRequestId),
      lastActivityAt: lastActivityAt.toISOString(),
      stalenessDeadline: isTerminalLifecycleEvent(eventType)
        ? undefined
        : new Date(lastActivityAt.getTime() + DEFAULT_LIFECYCLE_STALENESS_MS).toISOString(),
      summary: `pi-crew ${eventType} direct-agent event ${String(sourceRequestId)}`,
    };

    try {
      const response = await this.#fetchWithTimeout(
        `${this.#baseUrl()}/api/agent-work/lifecycle-events`,
        {
          method: "POST",
          headers: this.#jsonHeaders(),
          body: JSON.stringify(payload),
          signal,
        },
      );

      if (!response.ok) {
        this.#logger.warn("Lifecycle event POST returned non-OK", {
          eventType,
          status: response.status,
        });
        if (response.status >= 500) {
          // DESIGN: Keep telemetry visible while deployed Den Channels databases
          // may lag the code-level agent_work_lifecycle event-type migration.
          // Rationale: the compatibility route accepts lifecycle_status rows in
          // older schemas and preserves the canonical lifecycle type in metadata.
          await this.#postLegacyLifecycleActivityEvent(payload, signal);
          return;
        }
        throw lifecycleTelemetryError(eventType, response.status);
      }
    } catch (err: unknown) {
      if (isAbortError(err)) return;
      this.#logger.warn("Lifecycle event POST failed", {
        eventType,
        error: errorMessage(err),
      });
      if (err instanceof ConnectionError) throw err;
      throw new ConnectionError(
        `Lifecycle telemetry ${eventType} failed: ${errorMessage(err)}`,
      );
    }
  }

  async #postLegacyLifecycleActivityEvent(
    payload: LifecycleEventPayload,
    signal: AbortSignal,
  ): Promise<void> {
    const legacyPayload: LegacyLifecycleActivityPayload = {
      channelId: payload.channelId,
      projectId: payload.projectId,
      agentIdentity: payload.agentIdentity,
      deliveryRequestId: payload.directAgentEventId,
      workerRunId: payload.workerRunId,
      workerRole: payload.workerRole,
      taskId: payload.taskId,
      assignmentId: payload.assignmentId,
      eventType: "lifecycle_status",
      status: legacyLifecycleStatus(payload.eventType),
      deliveryStage: "observability",
      terminal: isTerminalLifecycleEvent(payload.eventType),
      summary: payload.summary,
      metadataJson: JSON.stringify({
        canonicalLifecycleEventType: payload.eventType,
        directAgentEventId: payload.directAgentEventId,
        sourceMessageId: payload.sourceMessageId,
        lastActivityAt: payload.lastActivityAt,
        stalenessDeadline: payload.stalenessDeadline,
        profileIdentity: payload.profileIdentity,
        agentInstanceId: payload.agentInstanceId,
        poolMemberId: payload.poolMemberId,
        sessionId: payload.sessionId,
      }),
      dedupeKey: `pi-crew-http:lifecycle:${payload.eventType}:${payload.directAgentEventId}`,
    };

    try {
      const response = await this.#fetchWithTimeout(
        `${this.#baseUrl()}/api/channel-activity-events`,
        {
          method: "POST",
          headers: this.#jsonHeaders(),
          body: JSON.stringify(legacyPayload),
          signal,
        },
      );
      if (!response.ok) {
        this.#logger.warn("Legacy lifecycle activity POST returned non-OK", {
          eventType: payload.eventType,
          status: response.status,
        });
        throw lifecycleTelemetryError(payload.eventType, response.status);
      }
    } catch (err: unknown) {
      if (isAbortError(err)) return;
      this.#logger.warn("Legacy lifecycle activity POST failed", {
        eventType: payload.eventType,
        error: errorMessage(err),
      });
      if (err instanceof ConnectionError) throw err;
      throw new ConnectionError(
        `Lifecycle telemetry ${payload.eventType} failed: ${errorMessage(err)}`,
      );
    }
  }

  async postGatewaySystemMessage(
    channelId: number,
    sourceKind: string,
    sourceId: string,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    const payload: GatewaySystemMessagePayload = {
      channelId,
      senderIdentity: this.#config.memberIdentity,
      messageKind: "agent_text",
      sourceKind,
      sourceId,
      body,
      deliveryRequestId: sourceId,
      dedupeKey: `pi-crew-http:${sourceKind}:${sourceId}`,
    };

    try {
      const response = await this.#fetchWithTimeout(
        `${this.#baseUrl()}/api/gateway/system-messages`,
        {
          method: "POST",
          headers: this.#jsonHeaders(),
          body: JSON.stringify(payload),
          signal,
        },
      );

      if (!response.ok) {
        this.#logger.warn("Gateway system-message POST returned non-OK", {
          sourceKind,
          status: response.status,
        });
      }
    } catch (err: unknown) {
      if (isAbortError(err)) return;
      this.#logger.warn("Gateway system-message POST failed", {
        sourceKind,
        error: errorMessage(err),
      });
    }
  }

  #directAgentEventsUrl(cursor: number | null, limit: number, channelId?: string): string {
    const params = new URLSearchParams();
    if (channelId === undefined) params.set("projectId", this.#config.projectId);
    else params.set("channelId", channelId);
    params.set("limit", String(limit));
    if (cursor !== null) {
      params.set("afterId", String(cursor));
    }
    return `${this.#baseUrl()}/api/direct-agent-events?${params.toString()}`;
  }

  #baseUrl(): string {
    return this.#config.baseUrl.replace(/\/+$/, "");
  }

  #jsonHeaders(): Record<string, string> {
    return {
      ...this.#authHeaders(),
      "Content-Type": "application/json",
    };
  }

  #authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#config.token.length > 0) {
      headers.Authorization = `Bearer ${this.#config.token}`;
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
    }, this.#timeoutMs);

    const combinedSignal = init.signal
      ? anySignal([init.signal, controller.signal])
      : controller.signal;

    try {
      return await this.#fetchFn(url, {
        ...init,
        signal: combinedSignal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function isDirectAgentEventItemArray(
  payload: unknown,
): payload is DirectAgentEventItem[] {
  return Array.isArray(payload) && payload.every(isDirectAgentEventItem);
}

function isDirectAgentEventListResponse(
  payload: unknown,
): payload is DirectAgentEventListResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return isDirectAgentEventItemArray(record.items);
}

function isDirectAgentEventItem(value: unknown): value is DirectAgentEventItem {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "number" && typeof record.channelId === "number";
}

function parseOptionalLong(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

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

function lifecycleTelemetryError(eventType: string, status: number): ConnectionError {
  return new ConnectionError(
    `Lifecycle telemetry ${eventType} failed with HTTP ${String(status)}`,
  );
}

function legacyLifecycleStatus(eventType: string): string {
  if (eventType === "completed" || eventType === "cleanup_completed") {
    return "completed";
  }
  if (eventType === "failed" || eventType === "timed_out") {
    return "failed";
  }
  if (eventType === "blocked") {
    return "blocked";
  }
  if (eventType === "heartbeat" || eventType === "checkpoint_seen") {
    return "interim";
  }
  return "started";
}

function isTerminalLifecycleEvent(eventType: string): boolean {
  return ["blocked", "completed", "failed", "timed_out"].includes(eventType);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
