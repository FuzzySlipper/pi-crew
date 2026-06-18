/**
 * Service-work channel consumer — polls #service-work for
 * background_review_trigger messages, implements claim-based idempotence,
 * and fires events for review subagent execution.
 *
 * The actual review subagent execution is done through the
 * DelegatedSpawnLifecycle spawned from a caretaker full agent session,
 * not directly from this consumer. This consumer handles:
 * 1. Polling #service-work for trigger messages
 * 2. Claim-based idempotence via background_review_started posting
 * 3. Detecting completed/failed reviews
 * 4. Emitting events for the lifecycle observability
 *
 * @module pi-crew/service-work-consumer
 */

import type { EventBus, Logger, ChannelProvider } from "@pi-crew/core";

// ── Types ──────────────────────────────────────────────────────

/** Structured trigger payload posted by the after_response hook. */
export interface BackgroundReviewTrigger {
  readonly type: "background_review_trigger";
  readonly profileId: string;
  readonly sessionId: string;
  readonly triggerType: "memory" | "skill" | "combined";
  readonly turnsSinceMemory: number;
  readonly itersSinceSkill: number;
}

/** Structured claim message posted by the first caretaker to claim a trigger. */
export interface BackgroundReviewStarted {
  readonly type: "background_review_started";
  readonly reviewId: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly triggerType: "memory" | "skill" | "combined";
  readonly claimedBy: string;
  readonly timestamp: string;
}

/** Structured completion message self-reported by a review subagent. */
export interface BackgroundReviewCompleted {
  readonly type: "background_review_completed";
  readonly reviewId: string;
  readonly outcome: "changes_made" | "no_changes" | "failed";
  readonly summary?: string;
}

/** Structured failure message. */
export interface BackgroundReviewFailed {
  readonly type: "background_review_failed";
  readonly reviewId: string;
  readonly reason: string;
}

export type ServiceWorkMessage =
  | BackgroundReviewTrigger
  | BackgroundReviewStarted
  | BackgroundReviewCompleted
  | BackgroundReviewFailed;

// ── Events ─────────────────────────────────────────────────────

export const ServiceWorkEvents = {
  /** A new background_review_trigger was received and claimed. */
  TriggerClaimed: "service_work.trigger_claimed",
  /** A background_review_completed message was received. */
  ReviewCompleted: "service_work.review_completed",
  /** A background_review_failed message was received. */
  ReviewFailed: "service_work.review_failed",
  /** A background_review_started message was received but another caretaker claimed it. */
  TriggerAlreadyClaimed: "service_work.trigger_already_claimed",
} as const;

// ── Options ────────────────────────────────────────────────────

/**
 * Required configuration for ServiceWorkConsumer.
 * All fields are required — no hardcoded fallbacks.
 * Values should come from BackgroundReviewConfig in config.ts.
 */
export interface ServiceWorkConsumerOptions {
  /** Base URL for the Den Channels API (e.g. "http://192.168.1.10:18081"). */
  readonly baseUrl: string;
  /** Channel ID to poll for service-work messages. */
  readonly channelId: string;
  /** TTL in ms for claim idempotence — triggers older than this are ignored. */
  readonly claimTTLMs: number;
  /** Whether the consumer should start polling. */
  readonly enabled: boolean;
  /** Agent identity used when claiming triggers. */
  readonly agentIdentity: string;
  /** Interval in ms between poll cycles. */
  readonly pollIntervalMs: number;
  /** Max messages to fetch per poll cycle. */
  readonly pollLimit: number;
  /** Delay in ms before the first poll after start(). */
  readonly startupDelayMs: number;
}

// ── ServiceWorkConsumer ─────────────────────────────────────────

/**
 * Polls #service-work for background_review_trigger messages,
 * implements claim-based idempotence, and emits lifecycle events.
 *
 * The actual review execution must be wired separately via the
 * TriggerClaimed event — this consumer owns the channel protocol
 * and claim logic, not the subagent execution.
 */
export class ServiceWorkConsumer {
  readonly #logger: Logger;
  readonly #eventBus: EventBus;
  readonly #channelProvider: ChannelProvider;
  readonly #baseUrl: string;
  readonly #channelId: string;
  readonly #claimTTLMs: number;
  readonly #enabled: boolean;
  readonly #agentIdentity: string;
  readonly #pollIntervalMs: number;
  readonly #pollLimit: number;
  readonly #startupDelayMs: number;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  constructor(
    logger: Logger,
    eventBus: EventBus,
    channelProvider: ChannelProvider,
    options: ServiceWorkConsumerOptions,
  ) {
    this.#logger = logger;
    this.#eventBus = eventBus;
    this.#channelProvider = channelProvider;
    this.#baseUrl = options.baseUrl;
    this.#channelId = options.channelId;
    this.#claimTTLMs = options.claimTTLMs;
    this.#enabled = options.enabled;
    this.#agentIdentity = options.agentIdentity;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#pollLimit = options.pollLimit;
    this.#startupDelayMs = options.startupDelayMs;
  }

  /** Start polling the service-work channel. */
  start(): void {
    if (!this.#enabled) {
      this.#logger.info("ServiceWorkConsumer disabled — skipping start");
      return;
    }
    if (this.#pollTimer !== null) return;

    this.#logger.info("ServiceWorkConsumer starting", {
      channelId: this.#channelId,
      pollIntervalMs: this.#pollIntervalMs,
    });

    this.#running = true;
    setTimeout(() => void this.#poll(), this.#startupDelayMs);
    this.#pollTimer = setInterval(() => void this.#poll(), this.#pollIntervalMs);
  }

  /** Stop polling and clean up. */
  stop(): void {
    this.#running = false;
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#logger.info("ServiceWorkConsumer stopped");
  }

  async #poll(): Promise<void> {
    if (!this.#running) return;

    try {
      const messages = await this.#fetchChannelMessages();
      if (messages.length === 0) return;

      const triggers = messages
        .map((m) => this.#parseMessage<BackgroundReviewTrigger>(m, "background_review_trigger"))
        .filter((m): m is BackgroundReviewTrigger => m !== null);

      const completions = messages
        .map((m) => this.#parseMessage<BackgroundReviewCompleted>(m, "background_review_completed"))
        .filter((m): m is BackgroundReviewCompleted => m !== null);

      const failures = messages
        .map((m) => this.#parseMessage<BackgroundReviewFailed>(m, "background_review_failed"))
        .filter((m): m is BackgroundReviewFailed => m !== null);

      // Emit completion/failure events
      for (const completed of completions) {
        this.#eventBus.emit({
          event: ServiceWorkEvents.ReviewCompleted,
          payload: { ...completed, channelId: this.#channelId },
        });
      }
      for (const failed of failures) {
        this.#eventBus.emit({
          event: ServiceWorkEvents.ReviewFailed,
          payload: { ...failed, channelId: this.#channelId },
        });
      }

      // Process unclaimed triggers
      const startedIds = new Set(
        messages
          .map((m) => this.#parseMessage<BackgroundReviewStarted>(m, "background_review_started"))
          .filter((m): m is BackgroundReviewStarted => m !== null)
          .map((s) => s.reviewId),
      );

      for (const trigger of triggers) {
        const reviewId = `${trigger.profileId}-${trigger.sessionId}-${trigger.triggerType}-${Date.now()}`;

        // Skip if already claimed
        if (startedIds.size > 0) {
          const alreadyClaimed = await this.#checkClaimed(trigger);
          if (alreadyClaimed) {
            this.#eventBus.emit({
              event: ServiceWorkEvents.TriggerAlreadyClaimed,
              payload: { ...trigger, reviewId, channelId: this.#channelId },
            });
            continue;
          }
        }

        // Claim the trigger
        await this.#claimTrigger(reviewId, trigger);
      }
    } catch (error: unknown) {
      this.#logger.warn("ServiceWorkConsumer poll failed", {
        error: String(error),
      });
    }
  }

  /**
   * Fetch recent messages from the #service-work channel via the Den Channels API.
   */
  async #fetchChannelMessages(): Promise<ReadonlyArray<Record<string, unknown>>> {
    const url = `${this.#baseUrl}/api/channels/${this.#channelId}/messages?limit=${this.#pollLimit}`;
    const response = await fetch(url);
    if (!response.ok) {
      this.#logger.warn("ServiceWorkConsumer fetch failed", {
        status: response.status,
        url,
      });
      return [];
    }
    const data = (await response.json()) as ReadonlyArray<Record<string, unknown>>;
    return data;
  }

  /**
   * Parse a structured message from channel content.
   */
  #parseMessage<T extends ServiceWorkMessage>(
    message: Record<string, unknown>,
    expectedType: string,
  ): T | null {
    const content = this.#getMessageText(message);
    if (content === null) return null;
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.type !== expectedType) return null;
      return parsed as unknown as T;
    } catch {
      return null;
    }
  }

  /**
   * Check whether a trigger was already claimed by querying the Den Channels
   * API for recent messages with background_review_started type.
   */
  async #checkClaimed(trigger: BackgroundReviewTrigger): Promise<boolean> {
    try {
      const startedMessages = await this.#fetchChannelMessages();
      for (const msg of startedMessages) {
        const started = this.#parseMessage<BackgroundReviewStarted>(msg, "background_review_started");
        if (
          started !== null &&
          started.profileId === trigger.profileId &&
          started.sessionId === trigger.sessionId &&
          started.triggerType === trigger.triggerType
        ) {
          return true;
        }
      }
    } catch {
      // On failure, assume not claimed (conservative — retry will happen next poll)
    }
    return false;
  }

  /**
   * Claim a trigger by posting a background_review_started message.
   */
  async #claimTrigger(reviewId: string, trigger: BackgroundReviewTrigger): Promise<void> {
    const claim: BackgroundReviewStarted = {
      type: "background_review_started",
      reviewId,
      profileId: trigger.profileId,
      sessionId: trigger.sessionId,
      triggerType: trigger.triggerType,
      claimedBy: this.#agentIdentity,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.#channelProvider.sendMessage(this.#channelId, {
        kind: "text",
        text: JSON.stringify(claim),
      });
      this.#logger.info("Background review trigger claimed", {
        reviewId,
        profileId: trigger.profileId,
        sessionId: trigger.sessionId,
        triggerType: trigger.triggerType,
      });
      this.#eventBus.emit({
        event: ServiceWorkEvents.TriggerClaimed,
        payload: { ...trigger, reviewId, channelId: this.#channelId },
      });
    } catch (error: unknown) {
      this.#logger.warn("Failed to claim trigger", {
        reviewId,
        error: String(error),
      });
    }
  }

  /**
   * Extract text content from a channel message.
   */
  #getMessageText(message: Record<string, unknown>): string | null {
    const text = (message.text ?? message.content ?? message.body ?? "") as string;
    if (typeof text !== "string" || text.length === 0) return null;
    return text;
  }
}
