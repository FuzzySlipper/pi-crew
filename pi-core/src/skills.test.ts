/**
 * Tests for skill frontmatter parsing and types.
 *
 * @module pi-core/skills.test
 */

import { describe, it, expect } from "vitest";
import { parseSkillFrontmatter } from "./skills.js";

describe("parseSkillFrontmatter", () => {
  it("parses minimal frontmatter with name and description", () => {
    const content = "---\nname: hello-skill\ndescription: A hello world skill\n---\n# Hello\nBody text";
    const { frontmatter, body } = parseSkillFrontmatter(content);

    expect(frontmatter.name).toBe("hello-skill");
    expect(frontmatter.description).toBe("A hello world skill");
    expect(frontmatter.version).toBeUndefined();
    expect(frontmatter.platforms).toBeUndefined();
    expect(frontmatter.category).toBeUndefined();
    expect(frontmatter.tags).toBeUndefined();
    expect(frontmatter.requiresToolsets).toBeUndefined();
    expect(frontmatter.config).toBeUndefined();
    expect(body).toBe("# Hello\nBody text");
  });

  it("parses full frontmatter with all optional fields", () => {
    const content = [
      "---",
      "name: full-skill",
      "description: A skill with all fields",
      "version: 1.2.3",
      "platforms: [linux, macos]",
      "category: coding",
      "tags: [typescript, testing]",
      "requiresToolsets: [terminal, browser]",
      "---",
      "# Full skill body",
    ].join("\n");

    const { frontmatter } = parseSkillFrontmatter(content);

    expect(frontmatter.name).toBe("full-skill");
    expect(frontmatter.description).toBe("A skill with all fields");
    expect(frontmatter.version).toBe("1.2.3");
    expect(frontmatter.platforms).toEqual(["linux", "macos"]);
    expect(frontmatter.category).toBe("coding");
    expect(frontmatter.tags).toEqual(["typescript", "testing"]);
    expect(frontmatter.requiresToolsets).toEqual(["terminal", "browser"]);
  });

  it("parses config variables from top-level config", () => {
    const content = [
      "---",
      "name: config-skill",
      "description: Skill with config",
      "config:",
      "  apiKey:",
      "    type: string",
      "    description: API key for service",
      "  maxRetries:",
      "    type: number",
      "    default: 3",
      "  verbose:",
      "    type: boolean",
      "    default: false",
      "---",
      "Body",
    ].join("\n");

    const { frontmatter } = parseSkillFrontmatter(content);

    expect(frontmatter.config).toBeDefined();
    expect(frontmatter.config!.apiKey).toEqual({
      type: "string",
      description: "API key for service",
    });
    expect(frontmatter.config!.maxRetries).toEqual({
      type: "number",
      default: 3,
    });
    expect(frontmatter.config!.verbose).toEqual({
      type: "boolean",
      default: false,
    });
  });

  it("handles Hermes-compatible metadata.hermes.config nesting", () => {
    const content = [
      "---",
      "name: hermes-skill",
      "description: Hermes-compatible skill",
      "metadata:",
      "  hermes.config:",
      "    port:",
      "      type: number",
      "      default: 8080",
      "---",
      "Body",
    ].join("\n");

    const { frontmatter } = parseSkillFrontmatter(content);

    expect(frontmatter.config).toBeDefined();
    expect(frontmatter.config!.port).toEqual({
      type: "number",
      default: 8080,
    });
  });

  it("filters platforms to only valid values", () => {
    const content = [
      "---",
      "name: platform-filter",
      "description: Test platform filtering",
      "platforms: [linux, macos, windows, beos]",
      "---",
      "Body",
    ].join("\n");

    const { frontmatter } = parseSkillFrontmatter(content);

    expect(frontmatter.platforms).toEqual(["linux", "macos", "windows"]);
  });

  it("throws when frontmatter block is missing", () => {
    expect(() => parseSkillFrontmatter("# No frontmatter\nJust body")).toThrow(
      "Skill file has no frontmatter block",
    );
  });

  it("throws when name is missing", () => {
    const content = "---\ndescription: No name\n---\nBody";
    expect(() => parseSkillFrontmatter(content)).toThrow("missing required field: name");
  });

  it("throws when description is missing", () => {
    const content = "---\nname: no-desc\n---\nBody";
    expect(() => parseSkillFrontmatter(content)).toThrow("missing required field: description");
  });

  it("throws when name exceeds 64 characters", () => {
    const longName = "a".repeat(65);
    const content = `---\nname: ${longName}\ndescription: Valid desc\n---\nBody`;
    expect(() => parseSkillFrontmatter(content)).toThrow("exceeds 64 characters");
  });

  it("throws when description exceeds 1024 characters", () => {
    const longDesc = "x".repeat(1025);
    const content = `---\nname: valid-name\ndescription: ${longDesc}\n---\nBody`;
    expect(() => parseSkillFrontmatter(content)).toThrow("exceeds 1024 characters");
  });

  it("handles empty frontmatter block", () => {
    const content = "---\n---\nBody";
    expect(() => parseSkillFrontmatter(content)).toThrow("has no frontmatter block");
  });

  it("handles quoted string values", () => {
    const content = '---\nname: quoted\nname: "quoted name"\ndescription: "A skill"\n---\nBody';
    // Note: second name key overwrites first in simple YAML parsing
    const { frontmatter } = parseSkillFrontmatter(content);
    expect(frontmatter.name).toBe("quoted name");
  });

  it("handles boolean and number values", () => {
    const content = [
      "---",
      "name: types-test",
      "description: Test type parsing",
      "version: 42",
      "---",
      "Body",
    ].join("\n");

    const { frontmatter } = parseSkillFrontmatter(content);
    expect(frontmatter.version).toBe("42"); // version is always String-ified
  });

  it("handles Windows line endings", () => {
    const content = "---\r\nname: crlf-skill\r\ndescription: Windows line endings\r\n---\r\nBody text";
    const { frontmatter, body } = parseSkillFrontmatter(content);

    expect(frontmatter.name).toBe("crlf-skill");
    expect(frontmatter.description).toBe("Windows line endings");
    expect(body).toBe("Body text");
  });

  it("handles body with no content after frontmatter", () => {
    const content = "---\nname: empty-body\ndescription: No body\n---";
    const { body } = parseSkillFrontmatter(content);
    expect(body).toBe("");
  });

  it("ignores comments in frontmatter", () => {
    const content = [
      "---",
      "# This is a comment",
      "name: comment-skill",
      "description: Has comments",
      "---",
      "Body",
    ].join("\n");

    const { frontmatter } = parseSkillFrontmatter(content);
    expect(frontmatter.name).toBe("comment-skill");
    expect(frontmatter.description).toBe("Has comments");
  });
});
