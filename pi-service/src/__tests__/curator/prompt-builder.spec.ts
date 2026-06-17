/** Tests for candidate list rendering (prompt-builder). */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildCandidateList } from "../../curator/prompt-builder.js";
import type { Logger } from "@pi-crew/core";

const MINIMAL_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeSkillsRoot(): string {
  return mkdtempSync(join(tmpdir(), "curator-candidates-test-"));
}

function createSkill(root: string, name: string, extraFiles?: Record<string, string>): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const content = extraFiles?.["SKILL.md"] ?? `# ${name}\nDescription for ${name}.\n`;
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
  // Mark as old enough to be a candidate
  const past = Date.now() - 10 * 24 * 60 * 60 * 1000;
  writeFileSync(join(dir, ".last_used"), new Date(past).toISOString(), "utf-8");

  // Create support file subdirectories if specified
  for (const [filePath, fcontent] of Object.entries(extraFiles ?? {})) {
    if (filePath === "SKILL.md") continue;
    const fullPath = join(dir, filePath);
    const parentDir = dirname(fullPath);
    if (parentDir !== dir) mkdirSync(parentDir, { recursive: true });
    writeFileSync(fullPath, fcontent, "utf-8");
  }
}

function createYoungSkill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\nBrand new skill.\n`, "utf-8");
  // Recent timestamp — below minAgeDays
  writeFileSync(join(dir, ".last_used"), new Date().toISOString(), "utf-8");
}

describe("buildCandidateList", () => {
  let root: string;

  beforeEach(() => {
    root = makeSkillsRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty list for empty skills root", () => {
    const result = buildCandidateList(root, new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    expect(result).toEqual([]);
  });

  it("includes old skills as candidates", () => {
    createSkill(root, "old-skill");
    const result = buildCandidateList(root, new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("old-skill");
  });

  it("excludes young skills below minAgeDays", () => {
    createYoungSkill(root, "brand-new");
    const result = buildCandidateList(root, new Date(), { minAgeDays: 5 }, MINIMAL_LOGGER);
    expect(result).toHaveLength(0);
  });

  it("excludes pinned skills", () => {
    createSkill(root, "pinned-skill");
    writeFileSync(join(root, "pinned-skill", ".pinned"), "", "utf-8");
    const result = buildCandidateList(root, new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    expect(result.map((c) => c.name)).not.toContain("pinned-skill");
  });

  it("includes support files count in candidate", () => {
    createSkill(root, "with-support", {
      "SKILL.md": "# With Support\n",
      "references/ref1.md": "# Ref 1\n",
      "templates/tmpl.yaml": "template: true\n",
    });
    const result = buildCandidateList(root, new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    expect(result).toHaveLength(1);
    expect(result[0].supportFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts description from SKILL.md", () => {
    createSkill(root, "desc-test", {
      "SKILL.md": "# Desc Test\nThis is a description line for the skill.\nMore content.\n",
    });
    const result = buildCandidateList(root, new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    expect(result[0].description).toContain("This is a description line");
  });

  it("infers provenance as 'active' for normal skills", () => {
    createSkill(root, "active-skill");
    const result = buildCandidateList(root, new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    expect(result[0].provenance).toBe("active");
  });

  it("infers provenance as 'pinned' for pinned skills (but skips them)", () => {
    createSkill(root, "pin-skip");
    writeFileSync(join(root, "pin-skip", ".pinned"), "", "utf-8");
    const result = buildCandidateList(root, new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    expect(result.map((c) => c.name)).not.toContain("pin-skip");
  });

  it("infers provenance as 'stale' for stale skills", () => {
    createSkill(root, "stale-skill");
    writeFileSync(join(root, "stale-skill", ".stale"), new Date().toISOString(), "utf-8");
    const result = buildCandidateList(root, new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    const stale = result.find((c) => c.name === "stale-skill");
    expect(stale?.provenance).toBe("stale");
  });

  it("handles missing skills root gracefully", () => {
    const result = buildCandidateList(join(root, "nonexistent"), new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    expect(result).toEqual([]);
  });

  it("respects SKILL.md content truncation boundary", () => {
    const longContent = "# Long\n" + "x".repeat(7000);
    createSkill(root, "long-skill", { "SKILL.md": longContent });
    const result = buildCandidateList(root, new Date(), { minAgeDays: 1 }, MINIMAL_LOGGER);
    expect(result[0].content.length).toBeLessThanOrEqual(6000);
  });
});
