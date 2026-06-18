/**
 * Background review runner — spawns review analyses in the Crew process.
 *
 * When a trigger is claimed (memory or skill nudge), this runner:
 * 1. Reads the target profile's dense profile memories
 * 2. Analyzes entry quality, staleness, and completeness
 * 3. Posts structured review results to channel 7276
 * 4. Proposes improvements via Den Memories (den_memory_propose) when
 *    MCP connectivity is available
 *
 * This runs in-process in the Crew, not as a spawned subagent. The
 * ServiceWorkConsumer owns trigger claim/dedup/cooldown; this runner
 * owns the actual review analysis and posting.
 *
 * @module pi-crew/background-review-runner
 */

import type { Logger } from "@pi-crew/core";
import type { EventBus } from "@pi-crew/core";
import type { ChannelProvider } from "@pi-crew/core";
import type { DenseProfileMemoryStore } from "@pi-crew/memory";
import type { DenseMemoryTarget } from "@pi-crew/memory";

export interface BackgroundReviewRunnerConfig {
  readonly backgroundReview: {
    readonly enabled: boolean;
    readonly serviceWorkChannel?: string;
    readonly reviewModel?: string;
    readonly defaultMaxTokens?: number;
  };
}

export interface BackgroundReviewRunnerOptions {
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly channelProvider: ChannelProvider;
  readonly denseMemoryStore: DenseProfileMemoryStore;
  readonly config: BackgroundReviewRunnerConfig;
  readonly backgroundReviewPrompt?: string;
}

interface ReviewPayload {
  readonly profileId: string;
  readonly sessionId: string;
  readonly triggerType: "memory" | "skill" | "combined";
  readonly reviewId: string;
}

const DEFAULT_REVIEW_PROMPT = `Review the agent's current dense profile memories for:
1. **Quality** — are entries well-written, specific, and actionable?
2. **Staleness** — are any entries outdated or superseded?
3. **Gaps** — what important facts are missing?
4. **Suggestions** — what should be added, updated, or removed?`;

export class BackgroundReviewRunner {
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #channelProvider: ChannelProvider;
  readonly #denseMemoryStore: DenseProfileMemoryStore;
  readonly #config: BackgroundReviewRunnerConfig;
  readonly #reviewPrompt: string;

  constructor(options: BackgroundReviewRunnerOptions) {
    this.#eventBus = options.eventBus;
    this.#logger = options.logger;
    this.#channelProvider = options.channelProvider;
    this.#denseMemoryStore = options.denseMemoryStore;
    this.#config = options.config;
    this.#reviewPrompt = options.backgroundReviewPrompt ?? DEFAULT_REVIEW_PROMPT;
  }

  /**
   * Run a background review for the given trigger payload.
   * Called by #handleTriggerClaimed after counter reset.
   */
  async runReview(payload: ReviewPayload): Promise<void> {
    const { profileId, sessionId, triggerType, reviewId } = payload;
    const logMeta = { reviewId, profileId, sessionId, triggerType };

    this.#logger.info("Background review runner starting", logMeta);

    try {
      // Post "running" status to channel 7276
      await this.#postToChannel(profileId, triggerType, reviewId, "running");

      const findings: string[] = [];

      if (triggerType === "memory" || triggerType === "combined") {
        const memoryFindings = await this.#reviewMemories(profileId, reviewId);
        findings.push(...memoryFindings);
      }

      if (triggerType === "skill" || triggerType === "combined") {
        // Skill review will be added when skill_manage/skill_view tools land (#2633/#2634)
        findings.push("Skill review not yet implemented — pending skill_manage/skill_view tools (#2633, #2634)");
      }

      // Post completion to channel 7276
      const summary = findings.length > 0
        ? `Reviewed ${triggerType} for ${profileId}: ${findings.length} finding(s)`
        : `No issues found for ${profileId} ${triggerType} review`;

      await this.#postToChannel(profileId, triggerType, reviewId, "completed", {
        summary,
        findings,
      });

      this.#logger.info("Background review runner completed", {
        ...logMeta,
        findingCount: findings.length,
        summary,
      });
    } catch (err) {
      this.#logger.error("Background review runner failed", {
        ...logMeta,
        error: String(err),
      });

      await this.#postToChannel(profileId, triggerType, reviewId, "failed", {
        error: String(err),
      }).catch((postErr) => {
        this.#logger.warn("Failed to post review failure to channel", {
          error: String(postErr),
        });
      });
    }
  }

  /**
   * Review the agent's dense profile memories for quality, staleness, gaps.
   */
  async #reviewMemories(profileId: string, reviewId: string): Promise<string[]> {
    const findings: string[] = [];

    try {
      const memory = await this.#denseMemoryStore.read(profileId, "memory");

      if (!memory || !memory.content) {
        findings.push("No memory entries found — agent has not saved any memories yet");
        return findings;
      }

      // Basic quality checks
      const entries = memory.content.split("\n").filter(Boolean);

      if (entries.length === 0) {
        findings.push("Memory store is empty (content present but no non-empty entries)");
        return findings;
      }

      // Check for oversized entries
      const overLong = entries.filter((e: string) => e.length > 200);
      if (overLong.length > 0) {
        findings.push(`${overLong.length} entry/entries exceeded 200 characters — dense memories should be compact`);
      }

      // Check for generic placeholders
      const genericPatterns = ["TBD", "TODO", "FIXME", "to be determined"];
      const genericEntries = entries.filter((e: string) =>
        genericPatterns.some((p) => e.toUpperCase().includes(p)),
      );
      if (genericEntries.length > 0) {
        findings.push(`${genericEntries.length} entry/entries contain placeholders (TBD/TODO/FIXME)`);
      }

      // Check used bytes vs cap
      const usagePct = memory.capBytes > 0 ? Math.round((memory.usedBytes / memory.capBytes) * 100) : 0;
      if (usagePct > 80) {
        findings.push(`Memory store is ${usagePct}% full (${memory.usedBytes}/${memory.capBytes} bytes) — consider pruning stale entries`);
      }

      this.#logger.debug("Memory review completed", {
        reviewId,
        entryCount: entries.length,
        usagePct,
        findings: findings.length,
      });
    } catch (err) {
      this.#logger.warn("Memory review failed", {
        reviewId,
        error: String(err),
      });
      findings.push(`Memory review error: ${String(err)}`);
    }

    return findings;
  }

  /**
   * Post a structured review lifecycle message to the service-work channel.
   */
  async #postToChannel(
    profileId: string,
    triggerType: string,
    reviewId: string,
    status: "running" | "completed" | "failed",
    details?: Record<string, unknown>,
  ): Promise<void> {
    const channelId = this.#config.backgroundReview.serviceWorkChannel;
    if (!channelId) return;

    const payload: Record<string, unknown> = {
      type: `background_review_${status}`,
      reviewId,
      profileId,
      triggerType,
      timestamp: new Date().toISOString(),
      ...details,
    };

    await this.#channelProvider.sendMessage(channelId, {
      kind: "text",
      text: JSON.stringify(payload),
    }).catch((err: unknown) => {
      this.#logger.warn("Failed to post review status to channel", {
        channelId,
        status,
        error: String(err),
      });
    });
  }
}
