/**
 * HTTP client for posting agent activity events to the Den Observation
 * service (POST /v1/observation/lifecycle-events).
 *
 * Fail-soft design: POST failures are logged but never propagate. If the
 * observationUrl is not configured, all calls are silently dropped (no-op).
 *
 * @module pi-crew/observation/observation-client
 */

import type { Logger } from "@pi-crew/core";

// ── Observation API payload types ─────────────────────────────

export interface AgentIdentity {
  /** Logical/profile identity (e.g. "pi-crew-runner", "spawned-coder"). */
  readonly profile: string;
  /** Concrete runtime/pool member instance (e.g. "pi-crew-runner-live"). */
  readonly instanceId: string;
  /** Optional session key for conversational/runtime sessions. */
  readonly sessionKey?: string;
}

export interface AgentActivityPayload {
  readonly kind: "agent_activity.v1";
  readonly schemaVersion: 1;
  /** Short human-readable breadcrumb text (<= 240 chars). */
  readonly summary: string;
  readonly severity: "info" | "success" | "warning" | "error";
  readonly visibility: "channel" | "task" | "agent" | "debug";
  readonly adapter: "pi-crew";
  readonly surface: string;
  readonly workRef?: {
    readonly projectId?: string;
    readonly taskId?: number;
    readonly assignmentId?: string;
    readonly runId?: string;
    readonly channelId?: string;
    readonly channelMessageId?: number;
  };
  readonly sessionKey?: string;
  readonly toolName?: string;
  readonly reasonCode?: string;
  readonly resultRef?: {
    readonly documentSlug?: string;
    readonly messageId?: number;
    readonly commit?: string;
    readonly artifactPath?: string;
  };
}

export interface ObservationEvent {
  readonly sourceDomain: "runtime" | "delivery" | "conversation" | "observation" | "legacy";
  readonly eventType: string;
  readonly agentIdentity: AgentIdentity;
  readonly runtimeInstanceId?: string;
  readonly payload: AgentActivityPayload;
}

// ── Configuration ─────────────────────────────────────────────

export interface ObservationClientConfig {
  /** Observation service base URL (e.g. "http://den-srv:8082"). When
   *  absent, all writes are silently dropped. */
  readonly baseUrl?: string;
  /** Standard fetch timeout in milliseconds. Default 5_000. */
  readonly timeoutMs?: number;
}

// ── Client ────────────────────────────────────────────────────

const DEFAULT_WRITE_TIMEOUT_MS = 5_000;

/**
 * Fail-soft HTTP client for posting observation lifecycle events.
 *
 * Designed for fire-and-forget use: emits via EventBus subscribers.
 * Never throws; failures are logged and dropped.
 */
export class ObservationClient {
  readonly #baseUrl: string | undefined;
  readonly #timeoutMs: number;
  readonly #logger: Logger;

  constructor(config: ObservationClientConfig, logger: Logger) {
    this.#baseUrl = config.baseUrl;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.#logger = logger;
  }

  /**
   * Post a single agent activity event to the observation service.
   * Safe to call from EventBus handlers — never throws.
   */
  post(event: ObservationEvent): void {
    if (this.#baseUrl === undefined || this.#baseUrl.length === 0) {
      return; // no-op when not configured
    }

    const url = `${this.#baseUrl}/v1/observation/lifecycle-events`;

    // Fire-and-forget — do not block the caller
    this.#post(url, event).catch((err: unknown) => {
      this.#logger.warn("Observation POST failed", {
        eventType: event.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async #post(url: string, event: ObservationEvent): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "<no body>");
        this.#logger.warn("Observation POST returned non-OK", {
          eventType: event.eventType,
          status: response.status,
          statusText: response.statusText,
          body: body.length > 200 ? `${body.slice(0, 200)}…` : body,
        });
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        this.#logger.warn("Observation POST timed out", {
          eventType: event.eventType,
          timeoutMs: this.#timeoutMs,
        });
        return;
      }
      throw err; // re-throw for the outer catch
    } finally {
      clearTimeout(timer);
    }
  }
}
