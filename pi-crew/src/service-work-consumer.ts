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

// ── Constants ──────────────────────────────────────────────────

const POLL_INTERVAL_MS = 15_000;
const POLL_LIMIT = 20;
const DEFAULT_CLAIM_TTL_MS = 60_000;

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
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  constructor(
    logger: Logger,
    eventBus: EventBus,
    channelProvider: ChannelProvider,
    options?: {
      readonly baseUrl?: string;
      readonly channelId?: string;
      readonly claimTTLMs?: number;
      readonly enabled?: boolean;
      readonly agentIdentity?: string;
    },
  ) {
    this.#logger = logger;
    this.#eventBus = eventBus;
    this.#channelProvider = channelProvider;
    this.#baseUrl = options?.baseUrl ?? "http://192.168.1.10:18081";
    this.#channelId = options?.channelId ?? "7276";
    this.#claimTTLMs = options?.claimTTLMs ?? DEFAULT_CLAIM_TTL_MS;
    this.#enabled = options?.enabled ?? true;
    this.#agentIdentity = options?.agentIdentity ?? "pi-crew";
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
      pollIntervalMs: POLL_INTERVAL_MS,
    });

    this.#running = true;
    setTimeout(() => void this.#poll(), 2_000);
    this.#pollTimer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS);
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
      const claimedIds = new Set(completions.map((c) => c.reviewId.split("-").slice(0, -1).join("-")));
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
    const url = `${this.#baseUrl}/api/channels/${this.#channelId}/messages?limit=${POLL_LIMIT}`;
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
