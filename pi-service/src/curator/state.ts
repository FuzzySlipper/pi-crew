/** Curator state storage — atomic curator_state.json read/write. */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface CuratorStateFile {
  lastRunAt: string | null;
  lastRunDurationMs: number;
  lastRunSummary: string;
  lastReportPath: string | null;
  paused: boolean;
  runCount: number;
  pinnedSkills: string[];
}

const DEFAULT_STATE: CuratorStateFile = {
  lastRunAt: null,
  lastRunDurationMs: 0,
  lastRunSummary: "",
  lastReportPath: null,
  paused: false,
  runCount: 0,
  pinnedSkills: [],
};

function statePath(skillsRoot: string): string {
  return join(skillsRoot, ".curator_state");
}

export function readCuratorState(skillsRoot: string): CuratorStateFile {
  const path = statePath(skillsRoot);
  if (!existsSync(path)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(path, "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeCuratorState(skillsRoot: string, state: CuratorStateFile): void {
  const path = statePath(skillsRoot);
  const tmp = path + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function markRunCompleted(
  skillsRoot: string,
  durationMs: number,
  summary: string,
): void {
  const state = readCuratorState(skillsRoot);
  state.lastRunAt = new Date().toISOString();
  state.lastRunDurationMs = durationMs;
  state.lastRunSummary = summary;
  state.runCount += 1;
  writeCuratorState(skillsRoot, state);
}

export function updatePinnedSkills(
  skillsRoot: string,
  pinned: string[],
): void {
  const state = readCuratorState(skillsRoot);
  state.pinnedSkills = pinned;
  writeCuratorState(skillsRoot, state);
}
