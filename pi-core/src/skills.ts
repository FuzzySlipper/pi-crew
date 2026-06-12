/**
 * Core skill types for the pi-crew skill model.
 *
 * Compatible with Hermes/OpenClaw SKILL.md format so existing skill files
 * parse without modification. Skills use `---`-delimited YAML frontmatter
 * (reusing pi-core's existing `extractFrontmatter`) plus a markdown body.
 *
 * @module pi-core/skills
 */

// ── Types ──────────────────────────────────────────────────────

/** A single configuration variable declared in skill frontmatter. */
export interface SkillConfigVar {
  readonly type: "string" | "number" | "boolean";
  readonly default?: string | number | boolean;
  readonly description?: string;
}

/**
 * Frontmatter for a pi-crew skill.
 *
 * Field names are Hermes-compatible. Optional fields default to `undefined`
 * so partial frontmatter (e.g. a minimal `name` + `description`) is valid.
 */
export interface SkillFrontmatter {
  /** Skill name, ≤64 chars, hyphens and underscores allowed. */
  readonly name: string;
  /** Human-readable description, ≤1024 chars. */
  readonly description: string;
  /** Semantic version string (e.g. `"1.0.0"`). */
  readonly version?: string;
  /** Supported platforms. */
  readonly platforms?: readonly ("linux" | "macos" | "windows")[];
  /** Free-form category for grouping (e.g. `"coding"`, `"research"`). */
  readonly category?: string;
  /** Tags for search and filtering. */
  readonly tags?: readonly string[];
  /** Toolset names this skill requires. */
  readonly requiresToolsets?: readonly string[];
  /** Configuration variable declarations. */
  readonly config?: Readonly<Record<string, SkillConfigVar>>;
}

/**
 * A fully loaded skill with resolved content.
 *
 * Constructed by the skill loader; stored in the skill registry.
 */
export interface SkillRecord {
  readonly name: string;
  readonly frontmatter: SkillFrontmatter;
  /** The markdown body (instructions) after the frontmatter. */
  readonly body: string;
  /** Linked files: filename → file content (e.g. references/, templates/). */
  readonly linkedFiles: Readonly<Record<string, string>>;
  /** Where this skill was loaded from. */
  readonly source: "filesystem" | "den_document";
  /** Filesystem path (for `filesystem` source) or Den slug. */
  readonly sourcePath?: string;
  /** ISO-8601 timestamp when the skill was loaded. */
  readonly loadedAt: string;
}

/** Skill lookup / filter query. */
export interface SkillQuery {
  /** Match skills whose name starts with this prefix. */
  readonly name?: string;
  /** Match skills in this category. */
  readonly category?: string;
  /** Match skills that include this tag. */
  readonly tag?: string;
  /** Match skills that support this platform. */
  readonly platform?: string;
}

// ── YAML-like frontmatter parsing ──────────────────────────────

/**
 * Simple YAML key-value parser for skill frontmatter.
 *
 * Handles:
 * - Scalar values: `key: value`
 * - Quoted strings: `key: "value with spaces"`
 * - Flow sequences: `key: [a, b, c]`
 * - Nested maps (multi-level): `config: ... apiKey: ... type: string`
 * - Dotted keys: `metadata.hermes.tags: [a, b]`
 *
 * Uses indent-level tracking to determine nesting depth.
 * Does **not** handle multi-line scalars, block sequences, or anchors.
 * This is intentional — skill frontmatter is deliberately simple.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSimpleYaml(yaml: string): Record<string, any> {
  const lines = yaml.split("\n");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root: Record<string, any> = {};

  /**
   * Parse a block of indented lines starting at `startIdx` with a given
   * indent level. Returns [parsed object, next index after block].
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parseBlock(startIdx: number, parentIndent: number): [Record<string, any>, number] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: Record<string, any> = {};
    let i = startIdx;

    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() === "" || line.trim().startsWith("#")) {
        i++;
        continue;
      }

      const indent = line.length - line.trimStart().length;
      // If this line is at or less indented than the parent, end this block
      if (indent <= parentIndent && i > startIdx) {
        break;
      }

      const trimmed = line.trim();
      const kvMatch = trimmed.match(/^([\w][\w.-]*)\s*:\s*(.*)/);
      if (!kvMatch) {
        i++;
        continue;
      }

      const key = kvMatch[1]!;
      const rawVal = kvMatch[2]!.trimEnd();

      if (rawVal === "") {
        // This is a nested map — peek at next line to see if it's more indented
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1]!;
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          if (nextIndent > indent && nextLine.trim() !== "") {
            // Recursively parse the nested block
            const [nested, nextIdx] = parseBlock(i + 1, indent);
            // DESIGN: Handle dotted keys like "hermes.config:" by expanding
            // into nested objects. This matches Hermes SKILL.md conventions
            // where metadata.hermes.config is written as an indented block
            // under "hermes.config:".
            assignDottedKey(obj, key, nested);
            i = nextIdx;
            continue;
          }
        }
        // Empty value with no nested children
        obj[key] = undefined;
      } else {
        obj[key] = parseValue(rawVal);
      }

      i++;
    }

    return [obj, i];
  }

  const [result, _] = parseBlock(0, -1);
  // Merge into root (parseBlock returns the root-level object)
  Object.assign(root, result);
  return root;
}

/**
 * Assign a value to a potentially-dotted key path, creating intermediate
 * objects as needed. E.g. `assignDottedKey(obj, "hermes.config", val)`
 * creates `obj.hermes = { config: val }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assignDottedKey(target: Record<string, any>, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split(".");
  if (parts.length === 1) {
    target[parts[0]!] = value;
    return;
  }
  // Walk/create intermediate objects
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: Record<string, any> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (current[part] === undefined || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]!] = value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseValue(raw: string): any {
  if (raw === "" || raw === "~" || raw === "null") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Flow sequence: [a, b, c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => parseValue(s.trim()));
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (!Number.isNaN(num)) return num;
  }

  return raw;
}

/**
 * Parse skill frontmatter from SKILL.md content.
 *
 * Extracts YAML frontmatter using the existing `extractFrontmatter` pattern,
 * then parses the simple YAML into a typed {@link SkillFrontmatter} object.
 * Returns both the parsed frontmatter and the markdown body.
 *
 * @param content - Full SKILL.md file content.
 * @throws {Error} If required fields (`name`, `description`) are missing or invalid.
 */
export function parseSkillFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  // Inline frontmatter extraction (same logic as extractFrontmatter in
  // frontmatter.ts, duplicated here to avoid circular dependency concerns
  // and to keep this module self-contained).
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  let yamlString: string | null = null;
  let body = normalized;

  if (normalized.startsWith("---")) {
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex !== -1) {
      yamlString = normalized.slice(4, endIndex);
      body = normalized.slice(endIndex + 4).trimStart();
    }
  }

  if (yamlString === null || yamlString.trim() === "") {
    throw new Error("Skill file has no frontmatter block");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = parseSimpleYaml(yamlString) as Record<string, any>;

  // Validate required fields
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw new Error("Skill frontmatter missing required field: name");
  }
  if (raw.name.length > 64) {
    throw new Error(`Skill name exceeds 64 characters: "${raw.name}"`);
  }
  if (typeof raw.description !== "string" || raw.description.length === 0) {
    throw new Error("Skill frontmatter missing required field: description");
  }
  if (raw.description.length > 1024) {
    throw new Error(`Skill description exceeds 1024 characters`);
  }

  // Build optional fields before constructing the readonly object
  const version = raw.version !== undefined ? String(raw.version) : undefined;
  const platforms = Array.isArray(raw.platforms)
    ? (raw.platforms as string[]).filter(
        (p): p is "linux" | "macos" | "windows" => p === "linux" || p === "macos" || p === "windows",
      )
    : undefined;
  const category = typeof raw.category === "string" ? raw.category : undefined;
  const tags = Array.isArray(raw.tags) ? (raw.tags as string[]).map(String) : undefined;
  const requiresToolsets = Array.isArray(raw.requiresToolsets)
    ? (raw.requiresToolsets as string[]).map(String)
    : undefined;

  // Handle config from metadata.hermes.config or top-level config
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configSource = (raw.metadata as any)?.hermes?.config ?? raw.config;
  let config: Readonly<Record<string, SkillConfigVar>> | undefined;
  if (typeof configSource === "object" && configSource !== null && !Array.isArray(configSource)) {
    const parsed: Record<string, SkillConfigVar> = {};
    for (const [key, val] of Object.entries(configSource)) {
      if (typeof val === "object" && val !== null) {
        const entry = val as Record<string, unknown>;
        parsed[key] = {
          type: (entry.type as SkillConfigVar["type"]) ?? "string",
          ...(entry.default !== undefined && { default: entry.default as string | number | boolean }),
          ...(typeof entry.description === "string" && { description: entry.description }),
        };
      }
    }
    if (Object.keys(parsed).length > 0) {
      config = parsed;
    }
  }

  const frontmatter: SkillFrontmatter = {
    name: raw.name as string,
    description: raw.description as string,
    ...(version !== undefined && { version }),
    ...(platforms !== undefined && { platforms }),
    ...(category !== undefined && { category }),
    ...(tags !== undefined && { tags }),
    ...(requiresToolsets !== undefined && { requiresToolsets }),
    ...(config !== undefined && { config }),
  };

  return { frontmatter, body };
}
