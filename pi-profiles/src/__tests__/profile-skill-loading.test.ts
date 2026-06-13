import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError } from "@pi-crew/core";
import { loadProfile } from "../loader.js";
import { assembleProfilePrompt } from "../system-prompt.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-profile-skills-"));
}

function writeProfile(root: string, id: string, yamlLines: readonly string[]): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.yaml"), yamlLines.join("\n"), "utf-8");
  writeFileSync(join(dir, "soul.md"), `${id} soul.`, "utf-8");
}

function writeSkill(baseDir: string, name: string, description: string, body: string): void {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      'version: "1.0.0"',
      "---",
      "",
      body,
    ].join("\n"),
    "utf-8",
  );
}

describe("filesystem profile skill loading", () => {
  it("loads all global and profile-local skills and injects bounded content", () => {
    const root = makeRoot();
    writeSkill(
      join(root, "skills"),
      "global-scout",
      "Global scout skill",
      "Use global scouting steps.",
    );
    writeSkill(
      join(root, "profiles", "agent", "skills"),
      "local-review",
      "Local review skill",
      "Use local review steps.",
    );
    writeProfile(join(root, "profiles"), "agent", [
      'name: "Agent"',
      'description: "Agent profile"',
      "skills: all",
      "",
    ]);

    const profile = loadProfile("agent", join(root, "profiles"));
    const prompt = assembleProfilePrompt(profile);

    expect(profile.skills.map((skill) => skill.name).sort()).toEqual([
      "global-scout",
      "local-review",
    ]);
    expect(prompt).toContain("## Skill: global-scout");
    expect(prompt).toContain("Use global scouting steps.");
    expect(prompt).toContain("## Skill: local-review");
    expect(prompt).toContain("Use local review steps.");
  });

  it("loads only named filesystem skills and fails clearly when one is missing", () => {
    const root = makeRoot();
    writeSkill(join(root, "skills"), "den-evidence", "Den evidence skill", "Cite Den handles.");
    writeProfile(join(root, "profiles"), "agent", [
      'name: "Agent"',
      'description: "Agent profile"',
      "skills:",
      "  - den-evidence",
      "",
    ]);

    expect(loadProfile("agent", join(root, "profiles")).skills.map((skill) => skill.name)).toEqual([
      "den-evidence",
    ]);

    writeProfile(join(root, "profiles"), "missing", [
      'name: "Missing"',
      'description: "Missing profile"',
      "skills:",
      "  - absent-skill",
      "",
    ]);
    expect(() => loadProfile("missing", join(root, "profiles"))).toThrow(ConfigurationError);
    expect(() => loadProfile("missing", join(root, "profiles"))).toThrow(/absent-skill/);
  });

  it("lets profile-local skills override global skills with the same name", () => {
    const root = makeRoot();
    writeSkill(join(root, "skills"), "shared", "Global shared", "Global body should not appear.");
    writeSkill(
      join(root, "profiles", "agent", "skills"),
      "shared",
      "Local shared",
      "Profile local body wins.",
    );
    writeProfile(join(root, "profiles"), "agent", [
      'name: "Agent"',
      'description: "Agent profile"',
      "skills: all",
      "",
    ]);

    const prompt = assembleProfilePrompt(loadProfile("agent", join(root, "profiles")));

    expect(prompt).toContain("Profile local body wins.");
    expect(prompt).not.toContain("Global body should not appear.");
  });

  it("preserves existing inline skill metadata arrays", () => {
    const root = makeRoot();
    writeProfile(join(root, "profiles"), "agent", [
      'name: "Agent"',
      'description: "Agent profile"',
      "skills:",
      "  - name: inline-skill",
      '    description: "Inline metadata"',
      '    version: "0.2.0"',
      "",
    ]);

    const profile = loadProfile("agent", join(root, "profiles"));

    expect(profile.skills).toEqual([
      { name: "inline-skill", description: "Inline metadata", version: "0.2.0" },
    ]);
    expect(assembleProfilePrompt(profile)).toContain("**inline-skill** (v0.2.0): Inline metadata");
  });
});
