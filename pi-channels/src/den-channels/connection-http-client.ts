/**
 * HTTP client helpers for Den Channels direct-agent-events.
 *
 * Keeps wire-level fetch/auth/timeout behavior out of the connection class
 * so the connection remains focused on DenConnection lifecycle semantics.
 *
 * @module pi-channels/den-channels/connection-http-client
 */

import type { Logger } from "@pi-crew/core";

import type { DenHttpConnectionConfig } from "./connection-types.js";

export interface DirectAgentEventItem {
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

interface GatewaySystemMessagePayload {
  readonly channelId: number;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly body: string;
  readonly memberIdentity: string;
}

export interface HttpDirectAgentClientOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

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
  ): Promise<DirectAgentEventItem[]> {
    const url = this.#directAgentEventsUrl(cursor, limit);
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
    if (!isDirectAgentEventItemArray(payload)) {
      this.#logger.warn("Unexpected direct-agent-events response shape");
      return [];
    }

    return payload;
  }

  async postLifecycleEvent(
    eventType: string,
    sourceRequestId: number,
    item: DirectAgentEventItem,
    signal: AbortSignal,
  ): Promise<void> {
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
      }
    } catch (err: unknown) {
      if (isAbortError(err)) return;
      this.#logger.warn("Lifecycle event POST failed", {
        eventType,
        error: errorMessage(err),
      });
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
      sourceKind,
      sourceId,
      body,
      memberIdentity: this.#config.memberIdentity,
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

  #directAgentEventsUrl(cursor: number | null, limit: number): string {
    const params = new URLSearchParams({
      projectId: this.#config.projectId,
      limit: String(limit),
    });
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

function isDirectAgentEventItem(value: unknown): value is DirectAgentEventItem {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "number" &&
    typeof record.channelId === "number" &&
    typeof record.memberIdentity === "string"
  );
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

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
