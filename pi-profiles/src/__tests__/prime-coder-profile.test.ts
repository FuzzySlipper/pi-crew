import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile } from "../loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_ROOT = join(__dirname, "..", "..", "profiles");
const PRIME_ROOT = join(PROFILES_ROOT, "prime-coder");
const LEGACY_METAPHOR_PATTERNS = [new RegExp("kni" + "ght", "i"), new RegExp("squi" + "re", "i")];

function readPrimeFile(relativePath: string): string {
  return readFileSync(join(PRIME_ROOT, relativePath), "utf-8");
}

describe("prime-coder profile", () => {
  it("loads as a profile-owned prime/assistant coding harness", () => {
    const profile = loadProfile("prime-coder", PROFILES_ROOT);

    expect(profile.name).toBe("Prime Coder");
    expect(profile.modelConfig).toMatchObject({ provider: "den-router", model: "grok" });
    expect(profile.runtimeConfig).toMatchObject({ maxIterations: 48 });
    expect(profile.toolPolicy).toEqual({
      mode: "allow_list",
      allow: expect.arrayContaining(["den", "filesystem", "terminal", "git", "delegation"]),
    });
    expect(profile.systemPrompt).toContain("Prime/assistant operating model");
    expect(profile.systemPrompt).toContain("Use assistant helpers for broad discovery");
    expect(profile.systemPrompt).toContain(
      "Treat delegated lifecycle success as helper availability only",
    );
  });

  it("ships bounded assistant helper prompt templates", () => {
    const scout = readPrimeFile("assistant-prompts/scout_codebase.md");
    const summarize = readPrimeFile("assistant-prompts/summarize_files.md");
    const paths = readPrimeFile("assistant-prompts/find_relevant_paths.md");

    expect(scout).toContain("path and line/range handles");
    expect(summarize).toContain("without dumping full contents");
    expect(paths).toContain("Group paths by implementation, tests, config, docs");
    expect([scout, summarize, paths].join("\n")).toContain("Do not modify files");
  });

  it("uses prime/assistant terminology instead of metaphor labels", () => {
    const content = [
      readPrimeFile("profile.yaml"),
      readPrimeFile("soul.md"),
      readPrimeFile("assistant-prompts/scout_codebase.md"),
      readPrimeFile("assistant-prompts/summarize_files.md"),
      readPrimeFile("assistant-prompts/find_relevant_paths.md"),
    ].join("\n");

    expect(content).toContain("Prime Coder");
    expect(content).toContain("assistant helpers");
    for (const pattern of LEGACY_METAPHOR_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });
});
