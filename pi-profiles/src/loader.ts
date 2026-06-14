/**
 * Profile loader — reads profile definitions from YAML + markdown files.
 *
 * Profiles support two on-disk shapes:
 * - Legacy flat files: `<id>.profile.yaml` + optional `<id>.profile.md`.
 * - Directory profiles: `<id>/profile.yaml` + required `<id>/soul.md`.
 *
 * Directory profiles may declare `extends: <parent-id>`. Inheritance is
 * resolved deterministically and fails closed on missing parents, cycles,
 * invalid sidecars, or invalid merged profiles.
 *
 * @module pi-profiles/loader
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { ConfigurationError } from "@pi-crew/core";
import type { Profile, ModelConfig, ToolPolicy, RuntimeConfig, McpConfig } from "./profile.js";
import { resolveProfileSkills } from "./skill-loading.js";

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
const DIRECTORY_PROFILE_YAML_FILES = ["profile.yaml", "profile.yml"];
const DEFAULT_PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "profiles");

interface RawProfileDefinition {
  readonly id: string;
  readonly doc: Record<string, unknown>;
  readonly prompt: string | undefined;
  readonly source: string;
  readonly profileDir?: string;
}

interface ResolvedProfileDefinition {
  readonly id: string;
  readonly doc: Record<string, unknown>;
  readonly prompt: string | undefined;
  readonly profileDir?: string;
}

/**
 * Loads profiles from a profiles root.
 *
 * Legacy flat profiles use `<id>.profile.yaml` and optional
 * `<id>.profile.md` sidecars. Directory profiles use
 * `<id>/profile.yaml` and a required `<id>/soul.md` sidecar.
 */
export class FilesystemProfileSource implements ProfileSource {
  private readonly profilesDir: string;

  constructor(profilesDir: string) {
    this.profilesDir = profilesDir;
  }

  listProfiles(): Profile[] {
    const definitions = this.loadDefinitions();
    const resolved = new Map<string, ResolvedProfileDefinition>();
    return [...definitions.keys()].sort().map((id) => {
      const definition = this.resolveDefinition(id, definitions, resolved, []);
      return parseProfile(definition, join(dirname(this.profilesDir), "skills"));
    });
  }

  // ── private ─────────────────────────────────────────────────

  private loadDefinitions(): Map<string, RawProfileDefinition> {
    let entries: ReadonlyArray<{
      readonly name: string;
      isFile(): boolean;
      isDirectory(): boolean;
    }>;
    try {
      entries = readdirSync(this.profilesDir, { withFileTypes: true });
    } catch (cause) {
      throw new ConfigurationError(
        `Cannot read profiles directory "${this.profilesDir}": ${String(cause)}`,
      );
    }

    const definitions = new Map<string, RawProfileDefinition>();
    for (const entry of entries) {
      if (entry.isFile() && PROFILE_YAML_RE.test(entry.name)) {
        const definition = this.loadLegacyFileProfile(entry.name);
        addDefinition(definitions, definition, this.profilesDir);
      }
      if (entry.isDirectory()) {
        const definition = this.loadDirectoryProfile(entry.name);
        if (definition !== undefined) {
          addDefinition(definitions, definition, this.profilesDir);
        }
      }
    }

    if (definitions.size === 0) {
      throw new ConfigurationError(`No profile YAML files found in "${this.profilesDir}"`);
    }
    return definitions;
  }

  private loadLegacyFileProfile(yamlFile: string): RawProfileDefinition {
    const id = PROFILE_YAML_RE.exec(yamlFile)?.[1];
    if (id === undefined) {
      // Should not happen — already filtered.
      throw new ConfigurationError(`Could not extract profile id from filename "${yamlFile}"`);
    }
    const yamlPath = join(this.profilesDir, yamlFile);
    const doc = this.parseProfileYaml(yamlPath, id);
    const mdPath = join(this.profilesDir, yamlFile.replace(/\.ya?ml$/, ".md"));
    const prompt = existsSync(mdPath)
      ? this.readUtf8(mdPath, `system prompt for "${id}"`)
      : undefined;
    return { id, doc, prompt, source: yamlPath };
  }

  private loadDirectoryProfile(profileId: string): RawProfileDefinition | undefined {
    const profileDir = join(this.profilesDir, profileId);
    const yamlPath = DIRECTORY_PROFILE_YAML_FILES.map((candidate) =>
      join(profileDir, candidate),
    ).find((candidate) => existsSync(candidate));
    if (yamlPath === undefined) {
      return undefined;
    }
    const soulPath = join(profileDir, "soul.md");
    if (!existsSync(soulPath)) {
      throw new ConfigurationError(
        `Directory profile "${profileId}" is missing required soul.md sidecar`,
      );
    }
    const doc = this.parseProfileYaml(yamlPath, profileId);
    const prompt = this.readUtf8(soulPath, `soul.md for "${profileId}"`);
    if (prompt.trim() === "") {
      throw new ConfigurationError(`Directory profile "${profileId}" soul.md must not be empty`);
    }
    return { id: profileId, doc, prompt, source: yamlPath, profileDir };
  }

  private parseProfileYaml(path: string, profileId: string): Record<string, unknown> {
    const raw = this.readUtf8(path, `profile YAML for "${profileId}"`);
    const parsed = parseYaml(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigurationError(`Profile YAML for "${profileId}" did not parse to an object`);
    }
    return parsed as Record<string, unknown>;
  }

  private resolveDefinition(
    id: string,
    definitions: ReadonlyMap<string, RawProfileDefinition>,
    resolved: Map<string, ResolvedProfileDefinition>,
    stack: readonly string[],
  ): ResolvedProfileDefinition {
    const cached = resolved.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (stack.includes(id)) {
      throw new ConfigurationError(
        `Profile inheritance cycle detected: ${[...stack, id].join(" -> ")}`,
      );
    }
    const definition = definitions.get(id);
    if (definition === undefined) {
      throw new ConfigurationError(`Profile "${id}" not found in "${this.profilesDir}"`);
    }

    const parentId = parseExtends(definition.doc, id);
    const nextStack = [...stack, id];
    const merged =
      parentId === undefined
        ? {
            id,
            doc: stripExtends(definition.doc),
            prompt: definition.prompt,
            profileDir: definition.profileDir,
          }
        : this.resolveChildDefinition(definition, parentId, definitions, resolved, nextStack);
    resolved.set(id, merged);
    return merged;
  }

  private resolveChildDefinition(
    child: RawProfileDefinition,
    parentId: string,
    definitions: ReadonlyMap<string, RawProfileDefinition>,
    resolved: Map<string, ResolvedProfileDefinition>,
    stack: readonly string[],
  ): ResolvedProfileDefinition {
    if (!definitions.has(parentId)) {
      throw new ConfigurationError(`Profile "${child.id}" extends missing parent "${parentId}"`);
    }
    const parent = this.resolveDefinition(parentId, definitions, resolved, stack);
    const childDoc = stripExtends(child.doc);
    return {
      id: child.id,
      doc: mergeProfileDocs(parent.doc, childDoc),
      prompt: mergePrompts(parent.prompt, parentId, child.prompt, child.id),
      profileDir: child.profileDir,
    };
  }

  private readUtf8(path: string, label: string): string {
    try {
      return readFileSync(path, "utf-8");
    } catch (cause) {
      throw new ConfigurationError(`Cannot read ${label} at "${path}": ${String(cause)}`);
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
export function loadProfile(profileId: string, profilesDir = DEFAULT_PROFILES_DIR): Profile {
  const profile = loadProfiles(profilesDir).find((candidate) => candidate.id === profileId);
  if (profile === undefined) {
    throw new ConfigurationError(`Profile "${profileId}" not found in "${profilesDir}"`);
  }
  return profile;
}

// ── Inheritance helpers ─────────────────────────────────────────

function addDefinition(
  definitions: Map<string, RawProfileDefinition>,
  definition: RawProfileDefinition,
  profilesDir: string,
): void {
  if (definitions.has(definition.id)) {
    throw new ConfigurationError(`Duplicate profile "${definition.id}" found in "${profilesDir}"`);
  }
  definitions.set(definition.id, definition);
}

function parseExtends(doc: Record<string, unknown>, profileId: string): string | undefined {
  const value = doc["extends"];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(
      `Profile "${profileId}" field "extends" must be a non-empty string`,
    );
  }
  return value;
}

function stripExtends(doc: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...doc };
  delete rest["extends"];
  return rest;
}

function mergeProfileDocs(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    const parentValue = output[key];
    if (isPlainRecord(parentValue) && isPlainRecord(value)) {
      output[key] = mergeProfileDocs(parentValue, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function mergePrompts(
  parentPrompt: string | undefined,
  parentId: string,
  childPrompt: string | undefined,
  childId: string,
): string | undefined {
  if (parentPrompt === undefined) {
    return childPrompt;
  }
  if (childPrompt === undefined) {
    return parentPrompt;
  }
  return [
    `<!-- Inherited prompt: ${parentId} -->`,
    parentPrompt.trimEnd(),
    "",
    `<!-- Profile prompt: ${childId} -->`,
    childPrompt.trimEnd(),
    "",
  ].join("\n");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── Validators ──────────────────────────────────────────────────

function parseProfile(definition: ResolvedProfileDefinition, globalSkillsDir: string): Profile {
  const doc = definition.doc;
  const name = expectString(doc, "name", definition.id);
  const description = expectString(doc, "description", definition.id);
  const systemPrompt = definition.prompt ?? expectString(doc, "systemPrompt", definition.id);
  const skills = resolveProfileSkills({
    profileId: definition.id,
    raw: doc["skills"],
    globalSkillsDir,
    profileSkillsDir:
      definition.profileDir === undefined ? undefined : join(definition.profileDir, "skills"),
  });
  const modelConfig: ModelConfig | undefined = parseModelConfig(doc, definition.id);
  const runtimeConfig: RuntimeConfig | undefined = parseRuntimeConfig(doc, definition.id);
  const mcpConfig: McpConfig | undefined = parseMcpConfig(doc, definition.id);
  const toolPolicy: ToolPolicy | undefined = parseToolPolicy(doc, definition.id);

  return {
    id: definition.id,
    name,
    description,
    systemPrompt,
    skills,
    modelConfig,
    runtimeConfig,
    mcpConfig,
    toolPolicy,
  };
}

function expectString(doc: Record<string, unknown>, key: string, profileId: string): string {
  const value = doc[key];
  if (value === undefined || value === null) {
    throw new ConfigurationError(`Profile "${profileId}" is missing required field "${key}"`);
  }
  if (typeof value !== "string") {
    throw new ConfigurationError(
      `Profile "${profileId}" field "${key}" must be a string, got ${typeof value}`,
    );
  }
  return value;
}

function parseModelConfig(
  doc: Record<string, unknown>,
  profileId: string,
): ModelConfig | undefined {
  const raw = doc["modelConfig"];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isPlainRecord(raw)) {
    throw new ConfigurationError(`Profile "${profileId}" field "modelConfig" must be an object`);
  }
  return raw;
}

function parseRuntimeConfig(
  doc: Record<string, unknown>,
  profileId: string,
): RuntimeConfig | undefined {
  const raw = doc["runtimeConfig"];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isPlainRecord(raw)) {
    throw new ConfigurationError(`Profile "${profileId}" field "runtimeConfig" must be an object`);
  }
  return raw;
}

function parseMcpConfig(doc: Record<string, unknown>, profileId: string): McpConfig | undefined {
  const raw = doc["mcpConfig"];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isPlainRecord(raw)) {
    throw new ConfigurationError(`Profile "${profileId}" field "mcpConfig" must be an object`);
  }
  return raw;
}

function parseToolPolicy(doc: Record<string, unknown>, profileId: string): ToolPolicy | undefined {
  const raw = doc["toolPolicy"];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isPlainRecord(raw)) {
    throw new ConfigurationError(`Profile "${profileId}" field "toolPolicy" must be an object`);
  }
  return raw;
}
