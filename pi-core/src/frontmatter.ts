/**
 * YAML frontmatter extraction from markdown content.
 *
 * Provides zero-dependency string utilities for splitting markdown
 * documents that use `---`-delimited YAML frontmatter:
 *
 * ```markdown
 * ---
 * key: value
 * ---
 * Body content here.
 * ```
 *
 * These functions extract the raw YAML string and body — they do **not**
 * parse YAML. Callers should use their preferred YAML library
 * (e.g. `js-yaml`, `yaml`) to parse the extracted frontmatter string.
 *
 * Attribution: adapted from pi-coding-agent's frontmatter utilities
 * at `/home/research/pi-fleet/pi/packages/coding-agent/src/utils/frontmatter.ts`.
 *
 * @module pi-core/frontmatter
 */

// ── Types ──────────────────────────────────────────────────────

/**
 * Result of extracting frontmatter from a markdown document.
 *
 * `yamlString` is the raw text between the `---` delimiters (may be empty).
 * `body` is the remaining content after the closing delimiter, with leading
 * whitespace trimmed.
 */
export interface FrontmatterExtraction {
  /** Raw YAML string between delimiters, or null if no frontmatter found. */
  readonly yamlString: string | null;
  /** Body content after the frontmatter block, with leading whitespace trimmed. */
  readonly body: string;
}

// ── Internal ───────────────────────────────────────────────────

/**
 * Normalize line endings to `\n`.
 *
 * Handles `\r\n` (Windows) and bare `\r` (classic Mac) so the
 * `---` delimiter search works consistently.
 */
function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Extract raw YAML frontmatter string and body from markdown content.
 *
 * Frontmatter is delimited by `---` at the start of the document,
 * followed by a closing `---` on its own line. The opening `---`
 * must be the very first characters of the document.
 *
 * Returns `{ yamlString: null, body }` when no valid frontmatter block
 * is found (no opening delimiter, no closing delimiter, or closing
 * delimiter appears before any content).
 */
function extractFrontmatter(content: string): FrontmatterExtraction {
  const normalized = normalizeNewlines(content);

  if (!normalized.startsWith("---")) {
    return { yamlString: null, body: normalized };
  }

  // Search for closing --- after the opening one.
  // The opening --- starts at index 0; content begins at index 3 (after "---").
  // The closing delimiter must start at the beginning of a line: preceded by \n.
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { yamlString: null, body: normalized };
  }

  return {
    yamlString: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trimStart(),
  };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Extract raw YAML frontmatter string and body from a markdown document.
 *
 * @param content - Markdown content, possibly with `---`-delimited frontmatter.
 * @returns The extracted YAML string (or null) and the body content.
 *
 * @example
 * ```ts
 * const { yamlString, body } = extractFrontmatter("---\ntitle: Hello\n---\nBody text");
 * // yamlString === "title: Hello"
 * // body === "Body text"
 * ```
 */
export { extractFrontmatter };

/**
 * Strip YAML frontmatter from a markdown document, returning only the body.
 *
 * Equivalent to `extractFrontmatter(content).body` but more ergonomic
 * when only the body is needed.
 *
 * @param content - Markdown content, possibly with frontmatter.
 * @returns The body content without the frontmatter block.
 *
 * @example
 * ```ts
 * stripFrontmatter("---\ntitle: Hello\n---\nBody text");
 * // returns "Body text"
 * ```
 */
export function stripFrontmatter(content: string): string {
  return extractFrontmatter(content).body;
}
