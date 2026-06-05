import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  FilesystemProfileSource,
  loadProfiles,
  type ProfileSource,
} from "../loader.js";
import { ConfigurationError } from "@pi-crew/core";
import type { Profile } from "../profile.js";

const FIXTURES = join(__dirname, "fixtures");

describe("FilesystemProfileSource", () => {
  // ── green paths ─────────────────────────────────────────────

  it("loads a profile from a YAML file with an .md sidecar", () => {
    const source = new FilesystemProfileSource(
      join(FIXTURES, "valid"),
    );
    const profiles = source.listProfiles();
    expect(profiles).toHaveLength(1);

    const p = profiles[0];
    if (p === undefined) {
      expect.unreachable("expected at least one profile");
    }
    expect(p.id).toBe("test-agent");
    expect(p.name).toBe("Test Agent");
    expect(p.description).toBe("A test profile for unit tests.");
    expect(p.systemPrompt).toContain("You are a test agent");
    expect(p.skills).toHaveLength(1);
    expect(p.skills[0]?.name).toBe("test-skill");
  });

  it("loadProfiles convenience returns profiles", () => {
    const profiles = loadProfiles(join(FIXTURES, "valid"));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe("test-agent");
  });

  it("loads the real production profiles", () => {
    const profilesDir = join(__dirname, "..", "..", "profiles");
    const profiles = loadProfiles(profilesDir);
    expect(profiles.length).toBeGreaterThanOrEqual(3);

    const ids = profiles.map((p) => p.id).sort();
    expect(ids).toContain("system-architect");
    expect(ids).toContain("pi-crew-planner");
    expect(ids).toContain("pi-crew-runner");

    // Every production profile must have a non-trivial system prompt.
    for (const p of profiles) {
      expect(p.systemPrompt.length).toBeGreaterThan(50);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it("profiles do not leak frontend/user-specific runtime state", () => {
    const profilesDir = join(__dirname, "..", "..", "profiles");
    const profiles = loadProfiles(profilesDir);
    for (const p of profiles) {
      const serialized = JSON.stringify(p);
      // No frontend or user-specific fields.
      expect(serialized).not.toContain("userId");
      expect(serialized).not.toContain("sessionId");
      expect(serialized).not.toContain("frontend");
      expect(serialized).not.toContain("preferences");
    }
  });

  it("toolPolicy is represented on production profiles", () => {
    const profilesDir = join(__dirname, "..", "..", "profiles");
    const profiles = loadProfiles(profilesDir);
    for (const p of profiles) {
      expect(p.toolPolicy).toBeDefined();
      if (p.toolPolicy !== undefined) {
        expect(p.toolPolicy.mode).toBe("allow_all");
      }
    }
  });

  // ── error paths ─────────────────────────────────────────────

  it("throws ConfigurationError for nonexistent directory", () => {
    const source = new FilesystemProfileSource(
      join(FIXTURES, "nonexistent-dir"),
    );
    expect(() => source.listProfiles()).toThrow(ConfigurationError);
  });

  it("throws ConfigurationError when name is missing", () => {
    const source = new FilesystemProfileSource(
      join(FIXTURES, "invalid-missing-name"),
    );
    expect(() => source.listProfiles()).toThrow(ConfigurationError);
    try {
      source.listProfiles();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      expect((e as ConfigurationError).message).toContain(
        'missing required field "name"',
      );
    }
  });

  it("throws ConfigurationError when YAML is not an object", () => {
    const source = new FilesystemProfileSource(
      join(FIXTURES, "invalid-not-object"),
    );
    expect(() => source.listProfiles()).toThrow(ConfigurationError);
  });

  it("throws ConfigurationError when skills are malformed", () => {
    const source = new FilesystemProfileSource(
      join(FIXTURES, "invalid-bad-skills"),
    );
    expect(() => source.listProfiles()).toThrow(ConfigurationError);
  });

  it("ConfigurationError has typed fields", () => {
    const source = new FilesystemProfileSource(
      join(FIXTURES, "invalid-missing-name"),
    );
    try {
      source.listProfiles();
      // Should not reach here.
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      const ce = e as ConfigurationError;
      expect(ce.code).toBe("CONFIGURATION_ERROR");
      expect(ce.statusCode).toBe(500);
      expect(ce.retryable).toBe(false);
    }
  });
});

describe("ProfileSource interface", () => {
  it("can be implemented by a custom source (future Den doc source path)", () => {
    class InMemorySource implements ProfileSource {
      private readonly profiles: Profile[];

      constructor(profiles: Profile[]) {
        this.profiles = profiles;
      }

      listProfiles(): Profile[] {
        return this.profiles;
      }
    }

    const p: Profile = {
      id: "custom",
      name: "Custom",
      description: "From in-memory",
      systemPrompt: "Custom prompt",
      skills: [],
    };
    const source = new InMemorySource([p]);
    const result = source.listProfiles();
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("custom");
  });
});
