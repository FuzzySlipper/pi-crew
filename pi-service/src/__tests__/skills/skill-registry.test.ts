/**
 * Tests for SkillRegistry.
 *
 * @module pi-service/__tests__/skills/skill-registry.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { FakeLogger } from "@pi-crew/core";
import type { SkillRecord } from "@pi-crew/core";

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = new Date().toISOString();
  return {
    name: "test-skill",
    frontmatter: {
      name: "test-skill",
      description: "A test skill",
    },
    body: "# Test Skill\n\nBody content",
    linkedFiles: {},
    source: "filesystem",
    sourcePath: "/skills/test-skill",
    loadedAt: now,
    ...overrides,
  };
}

describe("SkillRegistry", () => {
  let registry: SkillRegistry;
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
    registry = new SkillRegistry({ logger });
  });

  describe("register and get", () => {
    it("registers and retrieves a skill by name", () => {
      const skill = makeSkill();
      registry.register(skill);

      expect(registry.get("test-skill")).toBe(skill);
    });

    it("returns undefined for unknown skill", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("replaces an existing skill with the same name", () => {
      const skill1 = makeSkill({ body: "version 1" });
      const skill2 = makeSkill({ body: "version 2" });

      registry.register(skill1);
      registry.register(skill2);

      expect(registry.get("test-skill")).toBe(skill2);
      expect(registry.size).toBe(1);
    });

    it("logs when replacing an existing skill", () => {
      const skill1 = makeSkill();
      const skill2 = makeSkill();
      registry.register(skill1);
      registry.register(skill2);

      const debugs = logger.entries.filter(
        (e) => e.level === "debug" && e.message.includes("replacing"),
      );
      expect(debugs.length).toBe(1);
    });
  });

  describe("remove", () => {
    it("removes a registered skill", () => {
      registry.register(makeSkill());
      expect(registry.remove("test-skill")).toBe(true);
      expect(registry.get("test-skill")).toBeUndefined();
      expect(registry.size).toBe(0);
    });

    it("returns false for non-existent skill", () => {
      expect(registry.remove("nonexistent")).toBe(false);
    });
  });

  describe("size", () => {
    it("returns 0 when empty", () => {
      expect(registry.size).toBe(0);
    });

    it("returns the count of registered skills", () => {
      registry.register(makeSkill({ name: "a" }));
      registry.register(makeSkill({ name: "b" }));
      registry.register(makeSkill({ name: "c" }));
      expect(registry.size).toBe(3);
    });
  });

  describe("list (no query)", () => {
    it("returns all skills when no query provided", () => {
      const skill1 = makeSkill({ name: "alpha" });
      const skill2 = makeSkill({ name: "beta" });
      registry.register(skill1);
      registry.register(skill2);

      const all = registry.list();
      expect(all.length).toBe(2);
      expect(all.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    });

    it("returns empty array when registry is empty", () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe("list with name prefix filter", () => {
    beforeEach(() => {
      registry.register(makeSkill({ name: "code-review" }));
      registry.register(makeSkill({ name: "code-lint" }));
      registry.register(makeSkill({ name: "research-web" }));
    });

    it("filters by name prefix (case-insensitive)", () => {
      const results = registry.list({ name: "Code" });
      expect(results.length).toBe(2);
      expect(results.map((s) => s.name).sort()).toEqual(["code-lint", "code-review"]);
    });

    it("returns empty when no names match prefix", () => {
      expect(registry.list({ name: "zzz" })).toEqual([]);
    });
  });

  describe("list with category filter", () => {
    beforeEach(() => {
      registry.register(
        makeSkill({
          name: "coding-skill",
          frontmatter: {
            name: "coding-skill",
            description: "A coding skill",
            category: "coding",
          },
        }),
      );
      registry.register(
        makeSkill({
          name: "research-skill",
          frontmatter: {
            name: "research-skill",
            description: "A research skill",
            category: "research",
          },
        }),
      );
      registry.register(makeSkill({ name: "no-category" }));
    });

    it("filters by category (case-insensitive)", () => {
      const results = registry.list({ category: "Coding" });
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe("coding-skill");
    });

    it("excludes skills without a category", () => {
      const results = registry.list({ category: "coding" });
      expect(results.find((s) => s.name === "no-category")).toBeUndefined();
    });
  });

  describe("list with tag filter", () => {
    beforeEach(() => {
      registry.register(
        makeSkill({
          name: "tagged-skill",
          frontmatter: {
            name: "tagged-skill",
            description: "A tagged skill",
            tags: ["typescript", "testing"],
          },
        }),
      );
      registry.register(makeSkill({ name: "untagged-skill" }));
    });

    it("filters by tag (case-insensitive)", () => {
      const results = registry.list({ tag: "TypeScript" });
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe("tagged-skill");
    });

    it("excludes skills without tags", () => {
      const results = registry.list({ tag: "typescript" });
      expect(results.find((s) => s.name === "untagged-skill")).toBeUndefined();
    });
  });

  describe("list with platform filter", () => {
    beforeEach(() => {
      registry.register(
        makeSkill({
          name: "linux-skill",
          frontmatter: {
            name: "linux-skill",
            description: "Linux only",
            platforms: ["linux"],
          },
        }),
      );
      registry.register(
        makeSkill({
          name: "cross-platform-skill",
          frontmatter: {
            name: "cross-platform-skill",
            description: "All platforms",
            platforms: ["linux", "macos", "windows"],
          },
        }),
      );
    });

    it("filters by platform", () => {
      const results = registry.list({ platform: "macos" });
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe("cross-platform-skill");
    });

    it("excludes skills without the platform", () => {
      const results = registry.list({ platform: "windows" });
      expect(results.find((s) => s.name === "linux-skill")).toBeUndefined();
    });
  });

  describe("list with combined filters", () => {
    beforeEach(() => {
      registry.register(
        makeSkill({
          name: "code-review",
          frontmatter: {
            name: "code-review",
            description: "Code review",
            category: "coding",
            tags: ["review", "git"],
            platforms: ["linux", "macos"],
          },
        }),
      );
      registry.register(
        makeSkill({
          name: "code-lint",
          frontmatter: {
            name: "code-lint",
            description: "Code linting",
            category: "coding",
            tags: ["lint"],
            platforms: ["linux"],
          },
        }),
      );
    });

    it("AND-combines all filters", () => {
      const results = registry.list({
        name: "code",
        category: "coding",
        platform: "macos",
      });
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe("code-review");
    });
  });
});
