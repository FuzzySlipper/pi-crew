/** Tests for snapshot/rollback/prune operations. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshot, rollback, listSnapshots, pruneSnapshots } from "../../curator/snapshot.js";
import type { Logger } from "@pi-crew/core";

const MINIMAL_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeSkillsRoot(): string {
  return mkdtempSync(join(tmpdir(), "curator-snap-test-"));
}

function createSkill(root: string, name: string, content?: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content ?? `# ${name}\nContent\n`, "utf-8");
}

describe("snapshot", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a snapshot directory with all skill contents", () => {
    createSkill(root, "skill-a", "# Skill A");
    createSkill(root, "skill-b", "# Skill B");
    const snapPath = snapshot(root, undefined, MINIMAL_LOGGER);
    expect(existsSync(snapPath)).toBe(true);
    expect(existsSync(join(snapPath, "skill-a"))).toBe(true);
    expect(existsSync(join(snapPath, "skill-b"))).toBe(true);
    expect(readFileSync(join(snapPath, "skill-a", "SKILL.md"), "utf-8")).toBe("# Skill A");
    expect(existsSync(join(snapPath, "skill-b"))).toBe(true);
  });

  it("skips hidden directories in snapshot", () => {
    createSkill(root, "visible-skill", "# Visible");
    mkdirSync(join(root, ".hidden"));
    const snapPath = snapshot(root, undefined, MINIMAL_LOGGER);
    expect(existsSync(join(snapPath, "visible-skill"))).toBe(true);
    expect(existsSync(join(snapPath, ".hidden"))).toBe(false);
  });

  it("returns snapPath even with empty skills root", () => {
    const snapPath = snapshot(root, undefined, MINIMAL_LOGGER);
    expect(existsSync(snapPath)).toBe(true);
  });

  it("uses provided runId in snapshot path", () => {
    const snapPath = snapshot(root, "test-run-001", MINIMAL_LOGGER);
    expect(snapPath).toContain("test-run-001");
    expect(existsSync(snapPath)).toBe(true);
  });

  it("handles missing skills root gracefully", () => {
    const badRoot = join(root, "nonexistent");
    const snapPath = snapshot(badRoot);
    expect(existsSync(snapPath)).toBe(true);
  });
});

describe("rollback", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("restores skills from a snapshot", () => {
    createSkill(root, "original", "# Original\n");
    const snapPath = snapshot(root);

    // Modify original skill
    writeFileSync(join(root, "original", "SKILL.md"), "# Modified\n");

    // Rollback
    rollback(snapPath, root, MINIMAL_LOGGER);
    expect(readFileSync(join(root, "original", "SKILL.md"), "utf-8")).toBe("# Original\n");
  });

  it("removes skills not in snapshot", () => {
    createSkill(root, "before-snapshot", "# Before");
    const snapPath = snapshot(root);

    // Add a new skill after snapshot
    createSkill(root, "after-snapshot", "# After");

    // Rollback
    rollback(snapPath, root, MINIMAL_LOGGER);
    expect(existsSync(join(root, "before-snapshot"))).toBe(true);
    expect(existsSync(join(root, "after-snapshot"))).toBe(false);
  });

  it("throws for missing snapshot path", () => {
    expect(() => rollback("/nonexistent/path", root, MINIMAL_LOGGER)).toThrow("Snapshot path not found");
  });

  it("preserves system dotfiles during rollback", () => {
    createSkill(root, "my-skill", "# Keep\n");
    // Create some system state
    writeFileSync(join(root, ".curator_state"), '{"runCount":1}', "utf-8");
    const snapPath = snapshot(root);

    writeFileSync(join(root, "my-skill", "SKILL.md"), "# Changed\n");

    rollback(snapPath, root, MINIMAL_LOGGER);
    // System dotfile should still exist
    expect(existsSync(join(root, ".curator_state"))).toBe(true);
    expect(readFileSync(join(root, "my-skill", "SKILL.md"), "utf-8")).toBe("# Keep\n");
  });

  it("handles empty snapshot", () => {
    const snapPath = snapshot(root);
    rollback(snapPath, root, MINIMAL_LOGGER);
    // No crash
  });
});

describe("listSnapshots", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty array when no snapshots exist", () => {
    expect(listSnapshots(root)).toEqual([]);
  });

  it("lists snapshot directory names", () => {
    const snap1 = snapshot(root, "run-001");
    const snap2 = snapshot(root, "run-002");
    const names = listSnapshots(root);
    expect(names).toContain("run-001");
    expect(names).toContain("run-002");
  });

  it("returns snapshots sorted newest first", () => {
    snapshot(root, "run-001");
    snapshot(root, "run-002");
    const names = listSnapshots(root);
    // Both snapshots are present
    expect(names).toContain("run-001");
    expect(names).toContain("run-002");
  });
});

describe("pruneSnapshots", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes snapshots older than retention days", () => {
    // Create a recent snapshot to keep
    snapshot(root, "keep-me");

    // Create an old snapshot directory with mtime artificially aged
    const oldSnapParent = join(root, ".snapshots", "delete-me");
    mkdirSync(oldSnapParent, { recursive: true });
    writeFileSync(join(oldSnapParent, "marker"), "old", "utf-8");

    // Set file times directly using utimes
    const { utimesSync } = require("node:fs");
    const past = Date.now() - 100 * 24 * 60 * 60 * 1000;
    utimesSync(oldSnapParent, past / 1000, past / 1000);

    pruneSnapshots(root, 30, MINIMAL_LOGGER);
    expect(existsSync(join(root, ".snapshots", "keep-me"))).toBe(true);
  });

  it("handles missing snapshots directory", () => {
    expect(() => pruneSnapshots(join(root, "no-snap"), 30, MINIMAL_LOGGER)).not.toThrow();
  });

  it("preserves recent snapshots", () => {
    snapshot(root, "recent-run");
    pruneSnapshots(root, 30, MINIMAL_LOGGER);
    expect(existsSync(join(root, ".snapshots", "recent-run"))).toBe(true);
  });
});
