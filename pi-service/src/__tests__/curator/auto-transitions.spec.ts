/** Tests for auto-transitions — active→stale→archived lifecycle. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { applyAutoTransitions } from "../../curator/auto-transitions.js";
import type { Logger } from "@pi-crew/core";

const MINIMAL_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeSkillsRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "curator-test-"));
  return dir;
}

function createSkill(root: string, name: string, daysOld: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\nContent\n`, "utf-8");
  // Set mtime to daysOld days ago
  const past = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  const pastDate = new Date(past);
  // Use .last_used marker for precise age control
  writeFileSync(join(dir, ".last_used"), pastDate.toISOString(), "utf-8");
  return dir;
}

function markStale(root: string, name: string): void {
  writeFileSync(join(root, name, ".stale"), new Date().toISOString(), "utf-8");
}

function markPinned(root: string, name: string): void {
  writeFileSync(join(root, name, ".pinned"), "", "utf-8");
}

const STALE_AFTER = 30;
const ARCHIVE_AFTER = 90;
const DEFAULT_CONFIG = { staleAfterDays: STALE_AFTER, archiveAfterDays: ARCHIVE_AFTER };

describe("applyAutoTransitions", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("marks active skills as stale after staleAfterDays", () => {
    createSkill(root, "old-skill", STALE_AFTER + 1);
    const result = applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "stale", skillName: "old-skill" });
    expect(existsSync(join(root, "old-skill", ".stale"))).toBe(true);
  });

  it("archives stale skills after archiveAfterDays", () => {
    createSkill(root, "archive-candidate", ARCHIVE_AFTER + 5);
    markStale(root, "archive-candidate");
    const result = applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "archived", skillName: "archive-candidate" });
    // Should now be in .archive
    expect(existsSync(join(root, "archive-candidate"))).toBe(false);
    expect(existsSync(join(root, ".archive", "archive-candidate"))).toBe(true);
    expect(existsSync(join(root, ".archive", "archive-candidate", ".archived_at"))).toBe(true);
  });

  it("reactivates stale skills that have been used recently", () => {
    createSkill(root, "reactivated-skill", STALE_AFTER - 1);
    markStale(root, "reactivated-skill");
    const result = applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "reactivated", skillName: "reactivated-skill" });
    expect(existsSync(join(root, "reactivated-skill", ".stale"))).toBe(false);
  });

  it("skips pinned skills", () => {
    createSkill(root, "pinned-skill", STALE_AFTER + 10);
    markPinned(root, "pinned-skill");
    const result = applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toHaveLength(0);
    expect(existsSync(join(root, "pinned-skill"))).toBe(true);
    expect(existsSync(join(root, "pinned-skill", ".stale"))).toBe(false);
  });

  it("does not archive active skills below stale threshold", () => {
    createSkill(root, "recent-skill", STALE_AFTER - 5);
    const result = applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toHaveLength(0);
  });

  it("handles missing skills root gracefully", () => {
    const badRoot = join(root, "nonexistent");
    const result = applyAutoTransitions(badRoot, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toEqual([]);
  });

  it("handles empty skills root", () => {
    const result = applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toEqual([]);
  });

  it("creates .archive directory when first skill is archived", () => {
    createSkill(root, "first-archive", ARCHIVE_AFTER + 1);
    markStale(root, "first-archive");
    applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(existsSync(join(root, ".archive"))).toBe(true);
  });

  it("handles archive collision by continuing to next skill", () => {
    createSkill(root, "skill-a", ARCHIVE_AFTER + 5);
    markStale(root, "skill-a");
    createSkill(root, "skill-b", STALE_AFTER - 1); // Not stale
    const result = applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toHaveLength(1);
    expect(result[0].skillName).toBe("skill-a");
  });

  it("uses .last_used marker for age calculation", () => {
    createSkill(root, "with-last-used", STALE_AFTER + 3);
    const result = applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toHaveLength(1);
    expect(result[0].skillName).toBe("with-last-used");
  });

  it("does not process hidden directories", () => {
    mkdirSync(join(root, ".hidden-dir"));
    createSkill(root, "visible", STALE_AFTER + 1);
    const result = applyAutoTransitions(root, new Date(), DEFAULT_CONFIG, MINIMAL_LOGGER);
    expect(result).toHaveLength(1);
    expect(result[0].skillName).toBe("visible");
  });
});
