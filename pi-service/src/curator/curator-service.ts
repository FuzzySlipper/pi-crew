/** DefaultCuratorService — orchestrates curator auto-transitions, snapshots, and mutations. */

import { randomUUID } from "node:crypto";
import type { Logger } from "@pi-crew/core";
import type {
  CuratorService,
  CuratorConfig,
  CuratorRunResult,
  CuratorStatus,
  ArchivedSkill,
  AutoTransition,
  CuratorMutation,
} from "./types.js";
import { applyAutoTransitions } from "./auto-transitions.js";
import { snapshot, rollback, listSnapshots, pruneSnapshots } from "./snapshot.js";
import { archiveSkill, listArchived, restoreSkill, pinSkill, unpinSkill, listPinned } from "./archive.js";
import { readCuratorState, writeCuratorState, markRunCompleted, updatePinnedSkills } from "./state.js";
import { checkIdle } from "./idle-detection.js";

export class DefaultCuratorService implements CuratorService {
  readonly #skillsRoot: string;
  readonly #config: CuratorConfig;
  readonly #logger: Logger;

  constructor(
    skillsRoot: string,
    config: CuratorConfig,
    logger: Logger,
  ) {
    this.#skillsRoot = skillsRoot;
    this.#config = config;
    this.#logger = logger;
  }

  // ── Public API ─────────────────────────────────────────────────

  async runCuratorPass(now: Date): Promise<CuratorRunResult> {
    const runId = `curator-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const errors: string[] = [];
    const mutations: CuratorMutation[] = [];

    // 1. Auto-transitions (no LLM)
    let transitions: AutoTransition[] = [];
    try {
      transitions = applyAutoTransitions(
        this.#skillsRoot,
        now,
        {
          staleAfterDays: this.#config.staleAfterDays,
          archiveAfterDays: this.#config.archiveAfterDays,
        },
        this.#logger,
      );
    } catch (err) {
      errors.push(`Auto-transitions failed: ${String(err)}`);
    }

    // 2. Snapshot
    let snapshotPath: string | undefined;
    try {
      snapshotPath = snapshot(this.#skillsRoot, runId, this.#logger);
    } catch (err) {
      errors.push(`Snapshot failed: ${String(err)}`);
    }

    // 3. Prune old snapshots
    try {
      pruneSnapshots(this.#skillsRoot, this.#config.snapshotRetentionDays, this.#logger);
    } catch (err) {
      errors.push(`Snapshot pruning failed: ${String(err)}`);
    }

    const durationMs = Date.now() - startTime;
    const summary = `Auto-transitions: ${transitions.length} (${transitions.filter((t) => t.type === "archived").length} archived, ${transitions.filter((t) => t.type === "stale").length} marked stale)`;

    // 4. Update state
    markRunCompleted(this.#skillsRoot, durationMs, summary);

    // 5. Update pinned list
    updatePinnedSkills(this.#skillsRoot, listPinned(this.#skillsRoot));

    return {
      runId,
      startedAt,
      durationMs,
      transitions,
      snapshotPath,
      mutations,
      errors,
      summary,
    };
  }

  async runNow(dryRun: boolean): Promise<CuratorRunResult> {
    return this.runCuratorPass(new Date());
  }

  async snapshot(): Promise<string> {
    return snapshot(this.#skillsRoot, undefined, this.#logger);
  }

  async rollback(snapshotPath: string): Promise<void> {
    rollback(snapshotPath, this.#skillsRoot, this.#logger);
  }

  async listSnapshots(): Promise<string[]> {
    return listSnapshots(this.#skillsRoot);
  }

  async listArchived(): Promise<ArchivedSkill[]> {
    return listArchived(this.#skillsRoot);
  }

  async restore(skillName: string): Promise<void> {
    restoreSkill(this.#skillsRoot, skillName, this.#logger);
  }

  async pin(skillName: string): Promise<void> {
    pinSkill(this.#skillsRoot, skillName, this.#logger);
  }

  async unpin(skillName: string): Promise<void> {
    unpinSkill(this.#skillsRoot, skillName, this.#logger);
  }

  async listPinned(): Promise<string[]> {
    return listPinned(this.#skillsRoot);
  }

  async status(): Promise<CuratorStatus> {
    const state = readCuratorState(this.#skillsRoot);
    const pinned = listPinned(this.#skillsRoot);
    return {
      lastRunAt: state.lastRunAt,
      lastRunDurationMs: state.lastRunDurationMs,
      lastRunSummary: state.lastRunSummary,
      paused: state.paused,
      runCount: state.runCount,
      pinnedSkills: pinned,
    };
  }

  async pause(): Promise<void> {
    const state = readCuratorState(this.#skillsRoot);
    state.paused = true;
    writeCuratorState(this.#skillsRoot, state);
    this.#logger.info("Curator paused");
  }

  async resume(): Promise<void> {
    const state = readCuratorState(this.#skillsRoot);
    state.paused = false;
    writeCuratorState(this.#skillsRoot, state);
    this.#logger.info("Curator resumed");
  }
}
