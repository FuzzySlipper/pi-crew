/**
 * Curator service wrapper for pi-crew.
 *
 * Adapts the @pi-crew/service DefaultCuratorService (which requires a
 * `skillsRoot` parameter) to the pi-crew Crew's config shape by
 * deriving the skills root from the crew install layout.
 *
 * Also provides an internal auto-scheduler that runs the curator pass
 * on the configured cron schedule without requiring the ScriptCronJobExecutor.
 *
 * @module pi-crew/curator-service
 */

import { join } from "node:path";
import type { Logger } from "@pi-crew/core";
import {
  DefaultCuratorService as ServiceCuratorService,
  type CuratorConfig,
  type CuratorService,
  type CuratorRunResult,
  type CuratorStatus,
  type ArchivedSkill,
} from "@pi-crew/service";

export type { CuratorService, CuratorRunResult, CuratorStatus, ArchivedSkill };

/**
 * Minimum interval between auto-scheduler ticks (1 minute).
 * Prevents tight loops if the cron schedule has sub-minute resolution.
 */
const MIN_TICK_MS = 60_000;

/**
 * Wraps the pi-service DefaultCuratorService, deriving the skills root
 * from the crew install root when only the curator config and logger
 * are provided.
 *
 * The skills root is resolved as `{installRoot}/profiles/skills`.
 *
 * Also provides auto-scheduling: startAutoScheduler() runs curator passes
 * on the configured cron schedule using setTimeout chains.
 */
export class DefaultCuratorService implements CuratorService {
  readonly #inner: ServiceCuratorService;
  readonly #schedule: string;
  readonly #logger: Logger;
  readonly #enabled: boolean;
  #autoTimer: NodeJS.Timeout | null = null;

  constructor(
    config: CuratorConfig & { installRoot: string },
    logger: Logger,
  ) {
    const skillsRoot = join(config.installRoot, "profiles", "skills");
    this.#inner = new ServiceCuratorService(skillsRoot, config, logger);
    this.#schedule = config.cronSchedule;
    this.#logger = logger;
    this.#enabled = config.enabled;
  }

  // ── CuratorService implementation ───────────────────────────

  async runCuratorPass(now: Date): Promise<CuratorRunResult> {
    return this.#inner.runCuratorPass(now);
  }

  async runNow(dryRun: boolean): Promise<CuratorRunResult> {
    return this.#inner.runNow(dryRun);
  }

  async snapshot(): Promise<string> {
    return this.#inner.snapshot();
  }

  async rollback(snapshotPath: string): Promise<void> {
    return this.#inner.rollback(snapshotPath);
  }

  async listSnapshots(): Promise<string[]> {
    return this.#inner.listSnapshots();
  }

  async listArchived(): Promise<ArchivedSkill[]> {
    return this.#inner.listArchived();
  }

  async restore(skillName: string): Promise<void> {
    return this.#inner.restore(skillName);
  }

  async pin(skillName: string): Promise<void> {
    return this.#inner.pin(skillName);
  }

  async unpin(skillName: string): Promise<void> {
    return this.#inner.unpin(skillName);
  }

  async listPinned(): Promise<string[]> {
    return this.#inner.listPinned();
  }

  async status(): Promise<CuratorStatus> {
    return this.#inner.status();
  }

  async pause(): Promise<void> {
    return this.#inner.pause();
  }

  async resume(): Promise<void> {
    return this.#inner.resume();
  }

  // ── Auto-scheduler ──────────────────────────────────────────

  /**
   * Start the internal auto-scheduler. Runs the curator pass on the
   * configured cron schedule using setTimeout chains. The passed
   * CronExpression class (from @pi-crew/service) is used to calculate
   * the next run time after each completion.
   *
   * If the curator is paused, the scheduled check still fires but
   * skips execution and re-schedules.
   *
   * Safe to call multiple times — earlier schedulers are stopped first.
   */
  startAutoScheduler(): void {
    if (!this.#enabled) {
      this.#logger.debug("Curator auto-scheduler not started (disabled)");
      return;
    }
    this.stopAutoScheduler();
    this.#logger.info("Starting curator auto-scheduler", { schedule: this.#schedule });
    this.#scheduleNext();
  }

  /**
   * Stop the internal auto-scheduler if running.
   */
  stopAutoScheduler(): void {
    if (this.#autoTimer !== null) {
      clearTimeout(this.#autoTimer);
      this.#autoTimer = null;
    }
  }

  /**
   * Calculate delay to next cron run and schedule a timeout.
   */
  #scheduleNext(): void {
    try {
      // Dynamic import to avoid top-level loading issues
      const { CronExpression } = require("@pi-crew/service") as typeof import("@pi-crew/service");
      const cron = new CronExpression(this.#schedule);
      const now = new Date();
      const nextRun = cron.nextAfter(now);
      const delayMs = Math.max(MIN_TICK_MS, nextRun.getTime() - now.getTime());

      this.#autoTimer = setTimeout(() => {
        void this.#runScheduledPass();
      }, delayMs);

      this.#logger.debug("Curator auto-scheduler next run", {
        nextRun: nextRun.toISOString(),
        delayMs,
      });
    } catch (err) {
      this.#logger.warn("Failed to compute next curator schedule, retrying in 1 minute", {
        error: String(err),
      });
      this.#autoTimer = setTimeout(() => {
        void this.#scheduleNext();
      }, MIN_TICK_MS);
    }
  }

  /**
   * Execute the scheduled curator pass, then re-schedule the next one.
   */
  async #runScheduledPass(): Promise<void> {
    this.#autoTimer = null;

    try {
      // Check if paused
      const s = await this.status();
      if (s.paused) {
        this.#logger.info("Curator auto-scheduler: paused, skipping pass");
        this.#scheduleNext();
        return;
      }

      this.#logger.info("Curator auto-scheduler running pass");
      const result = await this.#inner.runNow(false);
      this.#logger.info("Curator auto-scheduler pass complete", {
        runId: result.runId,
        transitions: result.transitions.length,
        errors: result.errors.length,
        summary: result.summary,
      });
    } catch (err) {
      this.#logger.error("Curator auto-scheduler pass failed", {
        error: String(err),
      });
    } finally {
      // Always re-schedule for the next cron interval
      this.#scheduleNext();
    }
  }
}
