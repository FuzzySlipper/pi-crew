/** Integration tests for DefaultCuratorService — end-to-end pass, corner cases. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultCuratorService } from "../../curator/curator-service.js";
import type { Logger } from "@pi-crew/core";
import type { CuratorConfig } from "../../curator/types.js";

const MINIMAL_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const TEST_CONFIG: CuratorConfig = {
  enabled: true,
  cronSchedule: "0 0 * * *",
  staleAfterDays: 30,
  archiveAfterDays: 90,
  snapshotRetentionDays: 30,
  minAgeDays: 1,
  dryRun: false,
  maxTokens: 5000,
};

function makeSkillsRoot(): string {
  return mkdtempSync(join(tmpdir(), "curator-integration-"));
}

function createSkill(root: string, name: string, daysOld: number): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\nContent\n`, "utf-8");
  const past = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  writeFileSync(join(dir, ".last_used"), new Date(past).toISOString(), "utf-8");
}

function markStale(root: string, name: string): void {
  writeFileSync(join(root, name, ".stale"), new Date().toISOString(), "utf-8");
}

describe("DefaultCuratorService", () => {
  let root: string;
  let service: DefaultCuratorService;

  beforeEach(() => {
    root = makeSkillsRoot();
    service = new DefaultCuratorService(root, TEST_CONFIG, MINIMAL_LOGGER);
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors (e.g. from test that made dir unreadable)
    }
  });

  it("runNow completes successfully with empty skills root", async () => {
    const result = await service.runNow(false);
    expect(result.runId).toBeTruthy();
    expect(result.transitions).toEqual([]);
    expect(result.mutations).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.summary).toBeTruthy();
  });

  it("runNow archives stale old skills", async () => {
    createSkill(root, "archive-me", 95);
    markStale(root, "archive-me");
    createSkill(root, "keep-me", 15);
    const result = await service.runNow(false);
    // Should have at least included the stale→archived transition
    const archiveTrans = result.transitions.filter((t) => t.type === "archived");
    expect(archiveTrans.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(root, ".archive", "archive-me"))).toBe(true);
  });

  it("runNow marks stale skills", async () => {
    createSkill(root, "old-stale", 35);
    const result = await service.runNow(false);
    const staleTrans = result.transitions.filter((t) => t.type === "stale");
    expect(staleTrans.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(root, "old-stale", ".stale"))).toBe(true);
  });

  it("runNow creates a snapshot", async () => {
    createSkill(root, "snap-skill", 30);
    const result = await service.runNow(false);
    expect(result.snapshotPath).toBeTruthy();
    expect(existsSync(result.snapshotPath!)).toBe(true);
  });

  it("runCuratorPass accepts a specific date", async () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    createSkill(root, "far-future", 0);
    const result = await service.runCuratorPass(future);
    expect(result.runId).toBeTruthy();
  });

  // ── Snapshot / Rollback ──────────────────────────────────────

  it("snapshot and rollback cycle works end-to-end", async () => {
    createSkill(root, "before-snap", 30);
    const snapPath = await service.snapshot();
    writeFileSync(join(root, "before-snap", "SKILL.md"), "# Modified\n");
    createSkill(root, "after-snap", 10);
    await service.rollback(snapPath);
    expect(existsSync(join(root, "after-snap"))).toBe(false);
    expect(readFileSync(join(root, "before-snap", "SKILL.md"), "utf-8")).toContain("# before-snap");
  });

  it("listSnapshots returns snapshot ids", async () => {
    await service.snapshot();
    await service.snapshot();
    const snaps = await service.listSnapshots();
    expect(snaps.length).toBeGreaterThanOrEqual(2);
  });

  // ── Archive / Restore ────────────────────────────────────────

  it("archive → list → restore cycle works", async () => {
    createSkill(root, "cycle-skill", 10);
    await service.runNow(false);
    // Archive it directly
    const activeDir = join(root, "cycle-skill");
    if (existsSync(activeDir)) {
      const { archiveSkill: arch } = await import("../../curator/archive.js");
      arch(root, "cycle-skill");
    }
    const archived = await service.listArchived();
    expect(archived.some((a) => a.name === "cycle-skill")).toBe(true);
    await service.restore("cycle-skill");
    expect(existsSync(join(root, "cycle-skill"))).toBe(true);
  });

  it("listArchived returns empty when no archived skills", async () => {
    const archived = await service.listArchived();
    expect(archived).toEqual([]);
  });

  // ── Pin / Unpin ──────────────────────────────────────────────

  it("pin → unpin → list cycles", async () => {
    createSkill(root, "pin-cycle", 10);
    await service.pin("pin-cycle");
    let pinned = await service.listPinned();
    expect(pinned).toContain("pin-cycle");
    await service.unpin("pin-cycle");
    pinned = await service.listPinned();
    expect(pinned).not.toContain("pin-cycle");
  });

  it("pin protects skill from auto-transition", async () => {
    // Create a skill old enough to be stale but pinned
    createSkill(root, "protected", 50);
    await service.pin("protected");
    await service.runNow(false);
    // Should still be active
    expect(existsSync(join(root, "protected"))).toBe(true);
    expect(existsSync(join(root, "protected", ".stale"))).toBe(false);
  });

  it("listPinned returns empty when no pins", async () => {
    const pinned = await service.listPinned();
    expect(pinned).toEqual([]);
  });

  // ── Status / Pause / Resume ──────────────────────────────────

  it("status returns current state", async () => {
    const status = await service.status();
    expect(status).toHaveProperty("lastRunAt");
    expect(status).toHaveProperty("paused");
    expect(status).toHaveProperty("runCount");
    expect(status.paused).toBe(false);
  });

  it("pause and resume toggle state", async () => {
    await service.pause();
    let status = await service.status();
    expect(status.paused).toBe(true);
    await service.resume();
    status = await service.status();
    expect(status.paused).toBe(false);
  });

  it("status shows pinned skills", async () => {
    createSkill(root, "pinned-stat", 10);
    await service.pin("pinned-stat");
    const status = await service.status();
    expect(status.pinnedSkills).toContain("pinned-stat");
  });

  // ── Error recovery ──────────────────────────────────────────

  it("handles missing skills root gracefully", async () => {
    const badService = new DefaultCuratorService(
      join(root, "nonexistent"),
      TEST_CONFIG,
      MINIMAL_LOGGER,
    );
    const result = await badService.runNow(false);
    expect(result.runId).toBeTruthy();
  });

  it("runNow reports errors without throwing", async () => {
    // Make skills root non-existent — runNow should handle it gracefully
    const badService = new DefaultCuratorService(
      join(root, "nonexistent-dir"),
      TEST_CONFIG,
      MINIMAL_LOGGER,
    );
    const result = await badService.runNow(false);
    // Should not throw — result collects errors
    expect(result.runId).toBeTruthy();
  });
});
