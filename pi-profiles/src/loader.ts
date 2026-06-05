/**
 * Profile loader — reads profile definitions from YAML + markdown files.
 *
 * Profiles live in a single directory as `<id>.profile.yaml` files
 * with optional `<id>.profile.md` sidecar files for the system prompt.
 *
 * Every profile is validated at load time. Missing skills or malformed
 * definitions produce a {@link ConfigurationError} before the runtime
 * ever sees an incomplete profile.
 *
 * @module pi-profiles/loader
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { ConfigurationError } from "@pi-crew/core";
import type { Profile, Skill, ModelConfig, ToolPolicy } from "./profile.js";

// ── ProfileSource interface ─────────────────────────────────────

/**
 * Abstract source of raw profile definitions.
 *
 * The built-in {@link FilesystemProfileSource} reads YAML+markdown
 * from a directory. Future implementations can load from Den
 * documents, a database, or remote config without changing the
 * rest of the loader.
 */
export interface ProfileSource {
  /**
   * Return every profile defined by this source.
   *
   * Implementations should validate shapes and throw
   * {@link ConfigurationError} for any profile that would
   * fail at runtime.
   */
  listProfiles(): Profile[];
}

// ── Filesystem source ───────────────────────────────────────────

const PROFILE_YAML_RE = /^(.+)\.profile\.ya?ml$/;
const DEFAULT_PROFILES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "profiles",
);

/**
 * Loads profiles from a directory of `<id>.profile.yaml` files
 * with optional `<id>.profile.md` system-prompt sidecars.
 */
export class FilesystemProfileSource implements ProfileSource {
  private readonly profilesDir: string;

  constructor(profilesDir: string) {
    this.profilesDir = profilesDir;
  }

  listProfiles(): Profile[] {
    let entries: string[];
    try {
      entries = readdirSync(this.profilesDir);
    } catch (cause) {
      throw new ConfigurationError(
        `Cannot read profiles directory "${this.profilesDir}": ${String(cause)}`,
      );
    }

    const yamlFiles = entries.filter((e) => PROFILE_YAML_RE.test(e));

    if (yamlFiles.length === 0) {
      throw new ConfigurationError(
        `No profile YAML files found in "${this.profilesDir}"`,
      );
    }

    return yamlFiles.map((yamlFile) => this.loadOne(yamlFile));
  }

  // ── private ─────────────────────────────────────────────────

  private loadOne(yamlFile: string): Profile {
    const id = PROFILE_YAML_RE.exec(yamlFile)?.[1];
    if (id === undefined) {
      // Should not happen — already filtered.
      throw new ConfigurationError(
        `Could not extract profile id from filename "${yamlFile}"`,
      );
    }

    const yamlPath = join(this.profilesDir, yamlFile);
    const raw = this.readUtf8(yamlPath, `profile YAML for "${id}"`);
    const parsed = parseYaml(raw);

    if (parsed === null || typeof parsed !== "object") {
      throw new ConfigurationError(
        `Profile YAML "${yamlFile}" did not parse to an object`,
      );
    }

    const doc = parsed as Record<string, unknown>;

    // ── required fields ──────────────────────────────────────
    const name = expectString(doc, "name", id);
    const description = expectString(doc, "description", id);

    // ── system prompt: prefer sidecar .md, fall back to YAML ──
    const mdPath = join(
      this.profilesDir,
      yamlFile.replace(/\.ya?ml$/, ".md"),
    );
    let systemPrompt: string;
    try {
      systemPrompt = this.readUtf8(mdPath, `system prompt for "${id}"`);
    } catch {
      // No .md sidecar — fall back to the inline YAML field.
      systemPrompt = expectString(doc, "systemPrompt", id);
    }

    // ── skills ────────────────────────────────────────────────
    const skills: Skill[] = parseSkills(doc, id);

    // ── optional sections ─────────────────────────────────────
    const modelConfig: ModelConfig | undefined =
      doc["modelConfig"] as ModelConfig | undefined;
    const toolPolicy: ToolPolicy | undefined =
      doc["toolPolicy"] as ToolPolicy | undefined;

    return {
      id,
      name,
      description,
      systemPrompt,
      skills,
      modelConfig,
      toolPolicy,
    };
  }

  private readUtf8(path: string, label: string): string {
    try {
      return readFileSync(path, "utf-8");
    } catch (cause) {
      throw new ConfigurationError(
        `Cannot read ${label} at "${path}": ${String(cause)}`,
      );
    }
  }
}

// ── Type-safe defaults loader ───────────────────────────────────

/**
 * Convenience: load profiles from a directory with strong types,
 * throwing {@link ConfigurationError} on any load-time problem.
 *
 * Use this in gateway startup code. For tests that need specific
 * failure modes, construct a {@link FilesystemProfileSource}
 * directly.
 *
 * @param profilesDir - Absolute or relative path to the profiles directory.
 * @returns Array of fully-loaded {@link Profile} objects.
 */
export function loadProfiles(profilesDir = DEFAULT_PROFILES_DIR): Profile[] {
  return new FilesystemProfileSource(profilesDir).listProfiles();
}

/**
 * Load one profile by id from the filesystem profile source.
 *
 * @example
 * ```ts
 * const runner = loadProfile("pi-crew-runner");
 * ```
 */
export function loadProfile(
  profileId: string,
  profilesDir = DEFAULT_PROFILES_DIR,
): Profile {
  const profile = loadProfiles(profilesDir).find((candidate) =>
    candidate.id === profileId
  );
  if (profile === undefined) {
    throw new ConfigurationError(
      `Profile "${profileId}" not found in "${profilesDir}"`,
    );
  }
  return profile;
}

// ── Validators ──────────────────────────────────────────────────

function expectString(
  doc: Record<string, unknown>,
  key: string,
  profileId: string,
): string {
  const value = doc[key];
  if (value === undefined || value === null) {
    throw new ConfigurationError(
      `Profile "${profileId}" is missing required field "${key}"`,
    );
  }
  if (typeof value !== "string") {
    throw new ConfigurationError(
      `Profile "${profileId}" field "${key}" must be a string, got ${typeof value}`,
    );
  }
  return value;
}

function parseSkills(
  doc: Record<string, unknown>,
  profileId: string,
): Skill[] {
  const raw = doc["skills"];
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigurationError(
      `Profile "${profileId}" field "skills" must be an array`,
    );
  }
  return raw.map((item, index) => parseSkill(item, profileId, index));
}

function parseSkill(
  item: unknown,
  profileId: string,
  index: number,
): Skill {
  if (item === null || typeof item !== "object") {
    throw new ConfigurationError(
      `Profile "${profileId}" skill[${String(index)}] must be an object`,
    );
  }
  const s = item as Record<string, unknown>;
  const name = typeof s["name"] === "string" ? s["name"] : undefined;
  const description =
    typeof s["description"] === "string" ? s["description"] : "";
  const version =
    typeof s["version"] === "string" ? s["version"] : "0.1.0";

  if (name === undefined || name.trim() === "") {
    throw new ConfigurationError(
      `Profile "${profileId}" skill[${String(index)}] is missing required field "name"`,
    );
  }

  return { name, description, version };
}
