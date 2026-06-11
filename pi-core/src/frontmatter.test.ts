/**
 * Tests for frontmatter extraction utilities.
 *
 * @module pi-core/frontmatter.test
 */

import { describe, it, expect } from "vitest";
import { extractFrontmatter, stripFrontmatter } from "./frontmatter.js";

describe("extractFrontmatter", () => {
  it("extracts YAML string and body from valid frontmatter", () => {
    const content = "---\ntitle: Hello\n---\nBody text";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBe("title: Hello");
    expect(result.body).toBe("Body text");
  });

  it("handles multiline YAML frontmatter", () => {
    const content = "---\ntitle: Test\nauthor: Bot\nversion: 1.0\n---\n# Heading\nContent";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBe("title: Test\nauthor: Bot\nversion: 1.0");
    expect(result.body).toBe("# Heading\nContent");
  });

  it("returns null yamlString when no frontmatter is present", () => {
    const content = "# Just a heading\n\nSome text.";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBeNull();
    expect(result.body).toBe("# Just a heading\n\nSome text.");
  });

  it("returns null yamlString when opening --- is missing", () => {
    const content = "title: Hello\n---\nBody text";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBeNull();
    expect(result.body).toBe("title: Hello\n---\nBody text");
  });

  it("returns null yamlString when closing --- is missing", () => {
    const content = "---\ntitle: Hello\nBody text";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBeNull();
    expect(result.body).toBe("---\ntitle: Hello\nBody text");
  });

  it("handles empty frontmatter block", () => {
    const content = "---\n---\nBody text";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBe("");
    expect(result.body).toBe("Body text");
  });

  it("handles frontmatter with no body content", () => {
    const content = "---\ntitle: Hello\n---";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBe("title: Hello");
    expect(result.body).toBe("");
  });

  it("normalizes Windows line endings (\\r\\n)", () => {
    const content = "---\r\ntitle: Hello\r\n---\r\nBody text";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBe("title: Hello");
    expect(result.body).toBe("Body text");
  });

  it("normalizes classic Mac line endings (\\r)", () => {
    const content = "---\rtitle: Hello\r---\rBody text";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBe("title: Hello");
    expect(result.body).toBe("Body text");
  });

  it("handles frontmatter with extra whitespace after closing ---", () => {
    const content = "---\ntitle: Hello\n---  \n  Body text";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBe("title: Hello");
    // trimStart removes leading whitespace from body
    expect(result.body).toBe("Body text");
  });

  it("does not treat --- in body as closing delimiter", () => {
    const content = "---\ntitle: Hello\n---\nBody --- text\nMore content";
    const result = extractFrontmatter(content);
    expect(result.yamlString).toBe("title: Hello");
    expect(result.body).toBe("Body --- text\nMore content");
  });

  it("handles empty string input", () => {
    const result = extractFrontmatter("");
    expect(result.yamlString).toBeNull();
    expect(result.body).toBe("");
  });

  it("handles document that is only ---", () => {
    const result = extractFrontmatter("---");
    expect(result.yamlString).toBeNull();
    expect(result.body).toBe("---");
  });
});

describe("stripFrontmatter", () => {
  it("returns body when frontmatter is present", () => {
    expect(stripFrontmatter("---\ntitle: Hello\n---\nBody text")).toBe("Body text");
  });

  it("returns full content when no frontmatter is present", () => {
    expect(stripFrontmatter("Just content")).toBe("Just content");
  });

  it("returns empty string when content is only frontmatter", () => {
    expect(stripFrontmatter("---\ntitle: Hello\n---")).toBe("");
  });
});
