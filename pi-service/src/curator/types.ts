/** Curator types for pi-crew skill maintenance. */

import type { Logger } from "@pi-crew/core";

export type SkillProvenance = "bundled" | "profile" | "agent" | "pinned";
export type SkillLifecycleState = "active" | "stale" | "archived" | "pruned";
export type TriggerType = "memory" | "skill" | "combined";

export interface ArchivedSkill {
  name: string;
  archivedAt: string;
  originalPath: string;
}

export interface AutoTransition {
  type: "stale" | "archived" | "reactivated";
  skillName: string;
  daysSinceLastUse: number;
}

export interface CuratorMutation {
  type: "consolidate" | "archive" | "rename" | "update";
  skillName: string;
  target?: string;
  dryRun: boolean;
  applied: boolean;
  error?: string;
}

export interface CuratorRunResult {
  runId: string;
  startedAt: string;
  durationMs: number;
  transitions: AutoTransition[];
  snapshotPath?: string;
  mutations: CuratorMutation[];
  errors: string[];
  summary: string;
}

export interface CuratorConfig {
  enabled: boolean;
  cronSchedule: string;
  staleAfterDays: number;
  archiveAfterDays: number;
  snapshotRetentionDays: number;
  minAgeDays: number;
  dryRun: boolean;
  maxTokens: number;
  auxiliaryModel?: string;
  auxiliaryProvider?: string;
}

export interface CuratorStatus {
  lastRunAt: string | null;
  lastRunDurationMs: number;
  lastRunSummary: string;
  paused: boolean;
  runCount: number;
  pinnedSkills: string[];
}

export interface IdleCheckResult {
  idle: boolean;
  reason?: string;
}

export interface CuratorService {
  runCuratorPass(now: Date): Promise<CuratorRunResult>;
  runNow(dryRun: boolean): Promise<CuratorRunResult>;
  snapshot(): Promise<string>;
  rollback(snapshotPath: string): Promise<void>;
  listSnapshots(): Promise<string[]>;
  listArchived(): Promise<ArchivedSkill[]>;
  restore(skillName: string): Promise<void>;
  pin(skillName: string): Promise<void>;
  unpin(skillName: string): Promise<void>;
  listPinned(): Promise<string[]>;
  status(): Promise<CuratorStatus>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  enabled: false,
  cronSchedule: "0 0 */7 * *",
  staleAfterDays: 30,
  archiveAfterDays: 90,
  snapshotRetentionDays: 30,
  minAgeDays: 1,
  dryRun: true,
  maxTokens: 5000,
};
