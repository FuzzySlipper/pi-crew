/** Tests for archive management — archive/restore/pin/unpin with collision handling. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveSkill,
  listArchived,
  restoreSkill,
  pinSkill,
  unpinSkill,
  listPinned,
  isPinned,
} from "../../curator/archive.js";
import type { Logger } from "@pi-crew/core";

const MINIMAL_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeSkillsRoot(): string {
  return mkdtempSync(join(tmpdir(), "curator-archive-test-"));
}

function createSkill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`, "utf-8");
}

describe("archiveSkill", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("moves a skill to .archive directory", () => {
    createSkill(root, "test-skill");
    archiveSkill(root, "test-skill", MINIMAL_LOGGER);
    expect(existsSync(join(root, "test-skill"))).toBe(false);
    expect(existsSync(join(root, ".archive", "test-skill"))).toBe(true);
    expect(existsSync(join(root, ".archive", "test-skill", ".archived_at"))).toBe(true);
  });

  it("throws when skill does not exist", () => {
    expect(() => archiveSkill(root, "nonexistent", MINIMAL_LOGGER)).toThrow("Skill not found");
  });

  it("throws when skill is already archived", () => {
    createSkill(root, "dup-skill");
    archiveSkill(root, "dup-skill");
    // Re-create with the same name and archive again — should fail because
    // .archive/dup-skill already exists
    createSkill(root, "dup-skill");
    expect(() => archiveSkill(root, "dup-skill")).toThrow("already archived");
  });

  it("creates .archive directory automatically", () => {
    createSkill(root, "first-archive");
    archiveSkill(root, "first-archive");
    expect(existsSync(join(root, ".archive"))).toBe(true);
  });
});

describe("listArchived", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty array when no archive dir", () => {
    expect(listArchived(root)).toEqual([]);
  });

  it("returns archived skills with metadata", () => {
    createSkill(root, "skill-1");
    createSkill(root, "skill-2");
    archiveSkill(root, "skill-1");
    archiveSkill(root, "skill-2");
    const archived = listArchived(root);
    expect(archived).toHaveLength(2);
    const names = archived.map((a) => a.name).sort();
    expect(names).toEqual(["skill-1", "skill-2"]);
    expect(archived[0].archivedAt).toBeTruthy();
    expect(archived[0].originalPath).toBeTruthy();
  });
});

describe("restoreSkill", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("restores an archived skill back to active", () => {
    createSkill(root, "to-restore");
    archiveSkill(root, "to-restore");
    restoreSkill(root, "to-restore", MINIMAL_LOGGER);
    expect(existsSync(join(root, "to-restore"))).toBe(true);
    expect(existsSync(join(root, ".archive", "to-restore"))).toBe(false);
    expect(existsSync(join(root, "to-restore", "SKILL.md"))).toBe(true);
  });

  it("throws when archived skill not found", () => {
    expect(() => restoreSkill(root, "nonexistent", MINIMAL_LOGGER)).toThrow("Archived skill not found");
  });

  it("throws when active skill already exists", () => {
    createSkill(root, "clash");
    archiveSkill(root, "clash");
    createSkill(root, "clash"); // Create again (different session)
    expect(() => restoreSkill(root, "clash", MINIMAL_LOGGER)).toThrow("already exists");
  });
});

describe("pinSkill / unpinSkill", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates .pinned marker", () => {
    createSkill(root, "pin-me");
    pinSkill(root, "pin-me", MINIMAL_LOGGER);
    expect(existsSync(join(root, "pin-me", ".pinned"))).toBe(true);
  });

  it("throws when pinning nonexistent skill", () => {
    expect(() => pinSkill(root, "no-such-skill", MINIMAL_LOGGER)).toThrow("Skill not found");
  });

  it("removes .pinned marker on unpin", () => {
    createSkill(root, "unpin-me");
    pinSkill(root, "unpin-me", MINIMAL_LOGGER);
    unpinSkill(root, "unpin-me", MINIMAL_LOGGER);
    expect(existsSync(join(root, "unpin-me", ".pinned"))).toBe(false);
  });

  it("unpin is idempotent when no .pinned marker", () => {
    createSkill(root, "never-pinned");
    expect(() => unpinSkill(root, "never-pinned", MINIMAL_LOGGER)).not.toThrow();
  });
});

describe("listPinned", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty list when no pins", () => {
    expect(listPinned(root)).toEqual([]);
  });

  it("lists pinned skill names", () => {
    createSkill(root, "pinned-a");
    createSkill(root, "pinned-b");
    createSkill(root, "unpinned");
    pinSkill(root, "pinned-a");
    pinSkill(root, "pinned-b");
    const pinned = listPinned(root);
    expect(pinned).toHaveLength(2);
    expect(pinned).toContain("pinned-a");
    expect(pinned).toContain("pinned-b");
    expect(pinned).not.toContain("unpinned");
  });
});

describe("isPinned", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns true for pinned active skill", () => {
    createSkill(root, "active-pinned");
    pinSkill(root, "active-pinned");
    expect(isPinned(root, "active-pinned")).toBe(true);
  });

  it("returns false for unpinned active skill", () => {
    createSkill(root, "not-pinned");
    expect(isPinned(root, "not-pinned")).toBe(false);
  });

  it("returns true for pinned archived skill", () => {
    createSkill(root, "archived-pinned");
    pinSkill(root, "archived-pinned");
    archiveSkill(root, "archived-pinned");
    expect(isPinned(root, "archived-pinned")).toBe(true);
  });
});
