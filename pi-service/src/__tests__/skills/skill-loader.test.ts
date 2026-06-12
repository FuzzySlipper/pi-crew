/**
 * Tests for FilesystemSkillLoader.
 *
 * Uses real temp directories with SKILL.md files to exercise the loader
 * end-to-end without mocks.
 *
 * @module pi-service/__tests__/skills/skill-loader.test
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemSkillLoader } from "../../skills/skill-loader.js";
import { FakeLogger } from "@pi-crew/core";

describe("FilesystemSkillLoader", () => {
  let tempRoot: string;
  let logger: FakeLogger;
  let loader: FilesystemSkillLoader;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pi-skill-loader-test-"));
    logger = new FakeLogger();
    loader = new FilesystemSkillLoader({
      skillsDirs: [tempRoot],
      logger,
    });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  // ── Helpers ────────────────────────────────────────────────────

  async function createSkillDir(
    parentDir: string,
    name: string,
    skillMdContent: string,
    linkedFiles?: Record<string, string>,
  ): Promise<string> {
    const skillDir = join(parentDir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skillMdContent, "utf-8");

    if (linkedFiles) {
      for (const [relPath, content] of Object.entries(linkedFiles)) {
        const fullPath = join(skillDir, relPath);
        const dir = join(fullPath, "..");
        await mkdir(dir, { recursive: true });
        await writeFile(fullPath, content, "utf-8");
      }
    }

    return skillDir;
  }

  // ── loadFromDirectory ──────────────────────────────────────────

  describe("loadFromDirectory", () => {
    it("loads a skill from a directory with valid SKILL.md", async () => {
      const skillDir = await createSkillDir(tempRoot, "hello-skill", [
        "---",
        "name: hello-skill",
        "description: Says hello",
        "version: 1.0.0",
        "---",
        "# Hello",
        "",
        "This is the hello skill.",
      ].join("\n"));

      const result = await loader.loadFromDirectory(skillDir);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("hello-skill");
      expect(result!.frontmatter.description).toBe("Says hello");
      expect(result!.frontmatter.version).toBe("1.0.0");
      expect(result!.body).toBe("# Hello\n\nThis is the hello skill.");
      expect(result!.source).toBe("filesystem");
      expect(result!.sourcePath).toBe(skillDir);
      expect(result!.loadedAt).toBeTruthy();
    });

    it("returns null when directory has no SKILL.md", async () => {
      const emptyDir = join(tempRoot, "empty-skill");
      await mkdir(emptyDir, { recursive: true });

      const result = await loader.loadFromDirectory(emptyDir);
      expect(result).toBeNull();
    });

    it("returns null when SKILL.md has invalid frontmatter", async () => {
      const skillDir = await createSkillDir(tempRoot, "bad-skill", [
        "---",
        "description: Missing name field",
        "---",
        "Body",
      ].join("\n"));

      const result = await loader.loadFromDirectory(skillDir);
      expect(result).toBeNull();
    });

    it("loads linked files from references/ and templates/", async () => {
      const skillDir = await createSkillDir(
        tempRoot,
        "linked-skill",
        [
          "---",
          "name: linked-skill",
          "description: Has linked files",
          "---",
          "Body",
        ].join("\n"),
        {
          "references/api.md": "# API Reference\n\nDetails here.",
          "templates/output.tmpl": "Hello {{name}}!",
          "scripts/setup.sh": "#!/bin/bash\necho setup",
        },
      );

      const result = await loader.loadFromDirectory(skillDir);

      expect(result).not.toBeNull();
      expect(result!.linkedFiles["references/api.md"]).toBe("# API Reference\n\nDetails here.");
      expect(result!.linkedFiles["templates/output.tmpl"]).toBe("Hello {{name}}!");
      expect(result!.linkedFiles["scripts/setup.sh"]).toBe("#!/bin/bash\necho setup");
    });

    it("handles nested linked files", async () => {
      const skillDir = await createSkillDir(
        tempRoot,
        "nested-skill",
        [
          "---",
          "name: nested-skill",
          "description: Nested linked files",
          "---",
          "Body",
        ].join("\n"),
        {
          "references/sub/deep.md": "Deep content",
        },
      );

      const result = await loader.loadFromDirectory(skillDir);

      expect(result).not.toBeNull();
      expect(result!.linkedFiles["references/sub/deep.md"]).toBe("Deep content");
    });

    it("handles skill with no linked file directories", async () => {
      const skillDir = await createSkillDir(tempRoot, "minimal-skill", [
        "---",
        "name: minimal-skill",
        "description: Minimal",
        "---",
        "Body",
      ].join("\n"));

      const result = await loader.loadFromDirectory(skillDir);

      expect(result).not.toBeNull();
      expect(Object.keys(result!.linkedFiles)).toEqual([]);
    });
  });

  // ── loadAll ────────────────────────────────────────────────────

  describe("loadAll", () => {
    it("loads all skills from all configured directories", async () => {
      await createSkillDir(tempRoot, "skill-a", [
        "---",
        "name: skill-a",
        "description: First skill",
        "---",
        "Body A",
      ].join("\n"));

      await createSkillDir(tempRoot, "skill-b", [
        "---",
        "name: skill-b",
        "description: Second skill",
        "---",
        "Body B",
      ].join("\n"));

      // Create a non-directory file — should be skipped
      await writeFile(join(tempRoot, "README.md"), "Not a skill dir", "utf-8");

      const results = await loader.loadAll();

      expect(results.length).toBe(2);
      const names = results.map((s) => s.name).sort();
      expect(names).toEqual(["skill-a", "skill-b"]);
    });

    it("skips directories without SKILL.md", async () => {
      await mkdir(join(tempRoot, "empty-dir"), { recursive: true });
      await createSkillDir(tempRoot, "valid-skill", [
        "---",
        "name: valid-skill",
        "description: Valid",
        "---",
        "Body",
      ].join("\n"));

      const results = await loader.loadAll();
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe("valid-skill");
    });

    it("handles non-existent skills directory gracefully", async () => {
      const missingLogger = new FakeLogger();
      const missingLoader = new FilesystemSkillLoader({
        skillsDirs: ["/nonexistent/path/skills"],
        logger: missingLogger,
      });

      const results = await missingLoader.loadAll();
      expect(results).toEqual([]);

      const debugs = missingLogger.entries.filter(
        (e) => e.level === "debug" && e.message.includes("does not exist"),
      );
      expect(debugs.length).toBe(1);
    });

    it("scans multiple configured directories", async () => {
      const dir2 = await mkdtemp(join(tmpdir(), "pi-skill-loader-test2-"));

      try {
        await createSkillDir(tempRoot, "from-dir1", [
          "---",
          "name: from-dir1",
          "description: First dir",
          "---",
          "Body 1",
        ].join("\n"));

        await createSkillDir(dir2, "from-dir2", [
          "---",
          "name: from-dir2",
          "description: Second dir",
          "---",
          "Body 2",
        ].join("\n"));

        const multiLogger = new FakeLogger();
        const multiLoader = new FilesystemSkillLoader({
          skillsDirs: [tempRoot, dir2],
          logger: multiLogger,
        });

        const results = await multiLoader.loadAll();
        expect(results.length).toBe(2);
        const names = results.map((s) => s.name).sort();
        expect(names).toEqual(["from-dir1", "from-dir2"]);
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    });
  });
});
