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
  SkillCandidate,
  GenerateReportParams,
} from "./types.js";
import { applyAutoTransitions } from "./auto-transitions.js";
import { snapshot, rollback, listSnapshots, pruneSnapshots } from "./snapshot.js";
import { archiveSkill, listArchived, restoreSkill, pinSkill, unpinSkill, listPinned } from "./archive.js";
import { readCuratorState, writeCuratorState, markRunCompleted, updatePinnedSkills } from "./state.js";
import { checkIdle } from "./idle-detection.js";
import { buildCandidateList as buildCandidateListFromPrompt } from "./prompt-builder.js";
import { generateReport } from "./report.js";

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

  // ── Candidate list ────────────────────────────────────────────

  /**
   * Build a ranked candidate list of skills for curator review/consolidation.
   * Delegates to prompt-builder's buildCandidateList().
   */
  buildCandidateList(now: Date): SkillCandidate[] {
    return buildCandidateListFromPrompt(this.#skillsRoot, now, this.#config, this.#logger);
  }

  // ── Mutation execution ────────────────────────────────────────

  /**
   * Execute a curator mutation (consolidate, archive, prune, pin, unpin).
   * Maps the action string to the appropriate existing archive/pin/unpin methods.
   */
  async executeCuratorMutation(
    params: { action: string; from?: string; into?: string; absorbedInto?: string },
  ): Promise<{ success: boolean; error?: string }> {
    const { action, from, into, absorbedInto } = params;

    try {
      switch (action) {
        case "consolidate": {
          // Archive the source skill and create an umbrella skill with the target name
          if (!from) return { success: false, error: 'Missing "from" for consolidate' };
          if (!into) return { success: false, error: 'Missing "into" for consolidate' };
          archiveSkill(this.#skillsRoot, from, this.#logger);
          // Create umbrella (stub: log the intent; actual umbrella creation TBD)
          this.#logger.info(`Consolidate: archived "${from}", umbrella "${into}"`);
          return { success: true };
        }

        case "archive": {
          if (!from) return { success: false, error: 'Missing "from" for archive' };
          archiveSkill(this.#skillsRoot, from, this.#logger);
          return { success: true };
        }

        case "prune": {
          if (!from) return { success: false, error: 'Missing "from" for prune' };
          archiveSkill(this.#skillsRoot, from, this.#logger);
          if (absorbedInto) {
            this.#logger.info(`Prune: archived "${from}" absorbed into "${absorbedInto}"`);
          }
          return { success: true };
        }

        case "pin": {
          if (!from) return { success: false, error: 'Missing "from" for pin' };
          pinSkill(this.#skillsRoot, from, this.#logger);
          return { success: true };
        }

        case "unpin": {
          if (!from) return { success: false, error: 'Missing "from" for unpin' };
          unpinSkill(this.#skillsRoot, from, this.#logger);
          return { success: true };
        }

        default:
          return { success: false, error: `Unknown curator action: "${action}"` };
      }
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // ── Report generation ─────────────────────────────────────────

  /**
   * Generate a human-readable curator report.
   * Delegates to report.ts generateReport().
   */
  async generateCuratorReport(params: GenerateReportParams): Promise<string> {
    return generateReport(params, this.#logger);
  }
}
