/** Tests for curator state storage — read/write/markRunCompleted/updatePinnedSkills. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCuratorState, writeCuratorState, markRunCompleted, updatePinnedSkills } from "../../curator/state.js";

function makeSkillsRoot(): string {
  return mkdtempSync(join(tmpdir(), "curator-state-test-"));
}

describe("readCuratorState", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns default state when no file exists", () => {
    const state = readCuratorState(root);
    expect(state.lastRunAt).toBeNull();
    expect(state.paused).toBe(false);
    expect(state.runCount).toBe(0);
    expect(state.pinnedSkills).toEqual([]);
  });

  it("reads existing state file", () => {
    const initial = { lastRunAt: "2026-01-01T00:00:00.000Z", lastRunDurationMs: 500, lastRunSummary: "test", lastReportPath: null, paused: false, runCount: 5, pinnedSkills: ["test-skill"] };
    writeCuratorState(root, initial);
    const state = readCuratorState(root);
    expect(state.runCount).toBe(5);
    expect(state.lastRunAt).toBe("2026-01-01T00:00:00.000Z");
    expect(state.pinnedSkills).toEqual(["test-skill"]);
  });

  it("returns default state for corrupted file", () => {
    writeFileSync(join(root, ".curator_state"), "{invalid json}", "utf-8");
    const state = readCuratorState(root);
    expect(state.runCount).toBe(0);
  });
});

describe("writeCuratorState", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes state atomically", () => {
    writeCuratorState(root, { lastRunAt: "2026-06-01T00:00:00.000Z", lastRunDurationMs: 100, lastRunSummary: "ok", lastReportPath: null, paused: false, runCount: 1, pinnedSkills: [] });
    expect(existsSync(join(root, ".curator_state"))).toBe(true);
    const raw = readFileSync(join(root, ".curator_state"), "utf-8");
    expect(JSON.parse(raw).runCount).toBe(1);
  });

  it("does not leave temp files", () => {
    writeCuratorState(root, { lastRunAt: null, lastRunDurationMs: 0, lastRunSummary: "", lastReportPath: null, paused: false, runCount: 3, pinnedSkills: [] });
    const files = require("node:fs").readdirSync(root).filter((f: string) => f.startsWith(".curator_state.tmp"));
    expect(files).toHaveLength(0);
  });
});

describe("markRunCompleted", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("updates lastRunAt, duration, summary, and increments runCount", () => {
    markRunCompleted(root, 1234, "Transitions: 2 (1 archived, 1 stale)");
    const state = readCuratorState(root);
    expect(state.lastRunAt).toBeTruthy();
    expect(state.lastRunDurationMs).toBe(1234);
    expect(state.lastRunSummary).toBe("Transitions: 2 (1 archived, 1 stale)");
    expect(state.runCount).toBe(1);

    markRunCompleted(root, 567, "Another pass");
    const state2 = readCuratorState(root);
    expect(state2.runCount).toBe(2);
    expect(state2.lastRunDurationMs).toBe(567);
  });
});

describe("updatePinnedSkills", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("updates pinnedSkills in state", () => {
    updatePinnedSkills(root, ["skill-a", "skill-b"]);
    const state = readCuratorState(root);
    expect(state.pinnedSkills).toEqual(["skill-a", "skill-b"]);
  });

  it("overwrites previous pinned list", () => {
    updatePinnedSkills(root, ["old"]);
    updatePinnedSkills(root, ["new"]);
    const state = readCuratorState(root);
    expect(state.pinnedSkills).toEqual(["new"]);
  });
});
