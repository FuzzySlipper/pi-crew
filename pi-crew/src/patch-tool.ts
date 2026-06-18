/**
 * Patch tool — targeted find-and-replace file edits with fuzzy matching,
 * unified diff output, and post-write syntax-check rollback.
 *
 * Supports two modes:
 * - `"replace"` — single-file find-and-replace (common case)
 * - `"patch"` — multi-file V4A-format patches
 *
 * @module pi-crew/patch-tool
 */

import { promises as fs } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const execFileAsync = promisify(execFile);

// ── Public interface ─────────────────────────────────────────────

export interface PatchToolConfig {
  readonly rootPath: string;
  readonly maxOutputChars?: number;
}

/**
 * Create the `patch` AgentTool for find-and-replace edits.
 */
export function createPatchTool(config: PatchToolConfig): AgentTool {
  const maxChars = config.maxOutputChars ?? 8_000;

  const truncate = (text: string): string => {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}… [truncated]`;
  };

  return {
    label: "Patch",
    name: "patch",
    description: `Targeted find-and-replace file edits with fuzzy matching. Two modes:
- mode="replace" (default): replace old_string with new_string in one file.
- mode="patch": apply a multi-file V4A patch block.

In replace mode, fuzzy matching handles whitespace and indentation drift.
A unified diff is returned showing what changed.
After writing, a syntax check runs — if it introduces new errors the file is rolled back.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["replace", "patch"], default: "replace" },
        path: { type: "string", description: "File path under the delegated root (replace mode only)." },
        old_string: { type: "string", description: "Text to find and replace (replace mode)." },
        new_string: { type: "string", description: "Replacement text (replace mode). Empty string to delete." },
        replace_all: { type: "boolean", default: false, description: "Replace all occurrences when old_string matches multiple times." },
        cross_profile: { type: "boolean", default: false, description: "Allow edits that cross into other Hermes profiles." },
        patch: { type: "string", description: "V4A multi-file patch block (patch mode)." },
      },
      required: [],
    },
    execute: async (_toolCallId, params) => {
      const mode = stringParam(params, "mode", "replace");
      const crossProfile = params !== null && typeof params === "object" && (params as Record<string, unknown>)["cross_profile"] === true;

      if (mode === "patch") {
        return executePatchMode(params, config, crossProfile, truncate);
      }
      return executeReplaceMode(params, config, crossProfile, truncate);
    },
  };
}

// ── Replace mode ─────────────────────────────────────────────────

async function executeReplaceMode(
  params: unknown,
  config: PatchToolConfig,
  crossProfile: boolean,
  truncate: (text: string) => string,
): Promise<AgentToolResult> {
  const path = stringParam(params, "path");
  const oldString = stringParam(params, "old_string");
  const newString = stringParam(params, "new_string", "");
  const replaceAll = params !== null && typeof params === "object" && (params as Record<string, unknown>)["replace_all"] === true;

  if (path.length === 0) {
    return errorResult("path is required in replace mode");
  }
  if (oldString.length === 0) {
    return errorResult("old_string is required in replace mode");
  }

  let absolutePath: string;
  try {
    absolutePath = resolveInsideRoot(config.rootPath, path);
  } catch {
    return errorResult(`path escapes delegated root: ${path}`);
  }

  // Read the existing content
  let originalContent: string;
  try {
    originalContent = await fs.readFile(absolutePath, "utf8");
  } catch (error: unknown) {
    return errorResult(`Cannot read file ${path}: ${errorMessage(error)}`);
  }

  // Find the best match
  const matchResult = findBestMatch(originalContent, oldString, replaceAll);
  if (matchResult === undefined) {
    return errorResult(
      `Could not find a unique match for old_string in ${path}. ` +
      "Check that the text is present verbatim (including indentation and whitespace). " +
      "Use search_files to find the exact text first.",
    );
  }
  if (!matchResult.unique && !replaceAll) {
    return errorResult(
      `old_string matched ${String(matchResult.count)} times in ${path}. ` +
      "Set replace_all=true to replace all occurrences, or narrow old_string to a unique match.",
    );
  }

  // Verify write is inside root (already checked by resolveInsideRoot)
  // Check cross_profile guard
  if (!crossProfile && containsProfilePath(absolutePath)) {
    return errorResult(
      "path appears to reference another Hermes profile. " +
      "Set cross_profile=true to override this guard.",
    );
  }

  // Apply the replacement
  const replacementBase = matchResult.baseContent;
  const patchedContent = matchResult.replace(replacementBase, newString);

  // Build unified diff
  const diffLines = buildDiff(path, replacementBase, patchedContent, matchResult.count);
  const diff = diffLines.join("\n");

  // Write the file
  try {
    await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, patchedContent, "utf8");
  } catch (error: unknown) {
    return errorResult(`Failed to write ${path}: ${errorMessage(error)}`);
  }

  // Post-write syntax check + rollback on failure
  const syntaxResult = await checkSyntax(absolutePath);
  if (!syntaxResult.ok) {
    // Rollback
    try {
      await fs.writeFile(absolutePath, originalContent, "utf8");
    } catch {
      // Rollback failed — report both errors
      return errorResult(
        `Syntax check failed after edit (rollback attempted): ${syntaxResult.error}\n` +
        `WARNING: Rollback may have failed. File content at ${path} may be corrupted.`,
      );
    }
    return errorResult(
      `Syntax check failed after edit — file rolled back to original.\n${syntaxResult.error}`,
    );
  }

  return textResult(truncate(diff), {
    ok: true,
    path,
    replacements: matchResult.count,
    diff,
  });
}

// ── Patch mode ───────────────────────────────────────────────────

async function executePatchMode(
  params: unknown,
  config: PatchToolConfig,
  _crossProfile: boolean,
  truncate: (text: string) => string,
): Promise<AgentToolResult> {
  const patchBlock = stringParam(params, "patch");
  if (patchBlock.length === 0) {
    return errorResult("patch field is required in patch mode");
  }

  const files = parseV4APatch(patchBlock);
  if (files.length === 0) {
    return errorResult("Could not parse any file blocks from the patch content. Expected format:\n\n*** Begin Patch\n*** Update File: path/to/file\n@@ context hint @@\n context line\n-removed line\n+added line\n*** End Patch");
  }

  const results: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const absolutePath = resolveInsideRoot(config.rootPath, file.path);
    let originalContent: string;
    try {
      originalContent = await fs.readFile(absolutePath, "utf8");
    } catch (error: unknown) {
      errors.push(`Cannot read ${file.path}: ${errorMessage(error)}`);
      continue;
    }

    const patchedContent = applyV4AHunks(originalContent, file.hunks);
    if (patchedContent === originalContent) {
      errors.push(`No changes applied to ${file.path} — context lines did not match`);
      continue;
    }

    // Write
    try {
      await fs.mkdir(dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, patchedContent, "utf8");
    } catch (error: unknown) {
      errors.push(`Failed to write ${file.path}: ${errorMessage(error)}`);
      continue;
    }

    // Syntax check
    const syntaxResult = await checkSyntax(absolutePath);
    if (!syntaxResult.ok) {
      try {
        await fs.writeFile(absolutePath, originalContent, "utf8");
      } catch {
        errors.push(`${file.path}: syntax error (rollback may have failed): ${syntaxResult.error}`);
        continue;
      }
      errors.push(`${file.path}: syntax check failed — rolled back: ${syntaxResult.error}`);
      continue;
    }

    const diffLines = buildDiff(file.path, originalContent, patchedContent, 1);
    results.push(diffLines.join("\n"));
  }

  const output = [
    ...(results.length > 0 ? [`Applied ${String(results.length)} file(s)`, ...results] : []),
    ...(errors.length > 0 ? [`Errors (${String(errors.length)}):`, ...errors] : []),
  ].join("\n");

  return textResult(truncate(output), {
    ok: errors.length === 0,
    filesApplied: results.length,
    errors: errors.length,
    details: output,
  });
}

// ── Fuzzy matching ───────────────────────────────────────────────

interface MatchResult {
  /** Indices of all matches in the content. */
  readonly indices: readonly number[];
  /** Whether the match is unique (exactly 1 occurrence). */
  readonly unique: boolean;
  /** Number of occurrences found. */
  readonly count: number;
  /** Content to use as the base for replacement (may be normalized). */
  readonly baseContent: string;
  /** Produce replaced content from baseContent. */
  replace(content: string, replacement: string): string;
}

/**
 * Result of fuzzy matching. Returns the content to use as base and
 * the strategy name so callers know what happened.
 */
interface FuzzyMatchResult {
  /** The version of content the needle was found in. */
  readonly baseContent: string;
  /** The version of needle that was found. */
  readonly baseNeedle: string;
  /** Indices where the needle was found in baseContent. */
  readonly indices: readonly number[];
  /** Whether the matching involved normalization. */
  readonly normalized: boolean;
}

function findBestMatch(content: string, needle: string, allowMultiple: boolean): MatchResult | undefined {
  // Strategy 1: exact match — preserve original content exactly
  const exactIndices = allIndices(content, needle);
  if (exactIndices.length > 0) {
    return buildMatchResult(content, needle, exactIndices, allowMultiple);
  }

  // For fuzzy strategies, we work on a normalized version of the content.
  // The replacement is applied to the normalized content, not the original.
  // This is intentional: if the user asked for a fuzzy match, they accept
  // whitespace normalization as a side effect.

  // Strategy 2: trim trailing whitespace from each line
  const trimmedContent = content.split("\n").map((l) => l.trimEnd()).join("\n");
  const trimmedNeedle = needle.split("\n").map((l) => l.trimEnd()).join("\n");
  if (trimmedContent !== content || trimmedNeedle !== needle) {
    const indices = allIndices(trimmedContent, trimmedNeedle);
    if (indices.length > 0) {
      return buildMatchResult(trimmedContent, trimmedNeedle, indices, allowMultiple);
    }
  }

  // Strategy 3: trim both sides (full trim per line)
  const fullyTrimmedContent = content.split("\n").map((l) => l.trim()).join("\n");
  const fullyTrimmedNeedle = needle.split("\n").map((l) => l.trim()).join("\n");
  if (fullyTrimmedContent !== trimmedContent || fullyTrimmedNeedle !== trimmedNeedle) {
    const indices = allIndices(fullyTrimmedContent, fullyTrimmedNeedle);
    if (indices.length > 0) {
      return buildMatchResult(fullyTrimmedContent, fullyTrimmedNeedle, indices, allowMultiple);
    }
  }

  return undefined;
}

function allIndices(content: string, needle: string): number[] {
  const indices: number[] = [];
  let startIndex = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const idx = content.indexOf(needle, startIndex);
    if (idx === -1) break;
    indices.push(idx);
    startIndex = idx + 1;
  }
  return indices;
}

function buildMatchResult(
  originalContent: string,
  originalNeedle: string,
  indices: readonly number[],
  allowMultiple: boolean,
): MatchResult | undefined {
  if (indices.length === 0) return undefined;
  if (indices.length > 1 && !allowMultiple) {
    return {
      indices,
      unique: false,
      count: indices.length,
      baseContent: originalContent,
      replace: () => originalContent,
    };
  }

  const needleLength = originalNeedle.length;

  return {
    indices,
    unique: indices.length === 1,
    count: indices.length,
    baseContent: originalContent,
    replace: (content: string, replacement: string): string => {
      // Apply replacements in reverse order so indices don't shift
      const sorted = [...indices].sort((a, b) => b - a);
      let result = content;
      for (const idx of sorted) {
        result = result.slice(0, idx) + replacement + result.slice(idx + needleLength);
      }
      return result;
    },
  };
}

// ── V4A patch parsing ────────────────────────────────────────────

interface V4AFile {
  readonly path: string;
  readonly hunks: readonly V4AHunk[];
}

interface V4AHunk {
  readonly context: string;
  readonly removals: readonly string[];
  readonly additions: readonly string[];
}

function parseV4APatch(patchBlock: string): readonly V4AFile[] {
  const files: V4AFile[] = [];
  const filesFlushed = new Set<V4AFile>();
  const lines = patchBlock.split("\n");
  let currentFile: V4AFile | undefined;
  let currentHunk: V4AHunk | undefined;
  let currentRemovals: string[] = [];
  let currentAdditions: string[] = [];

  for (const line of lines) {
    const startMatch = /^\*\*\*\s*Begin\s+Patch\s*$/i.exec(line);
    if (startMatch !== null) continue;

    const endMatch = /^\*\*\*\s*End\s+Patch\s*$/i.exec(line);
    if (endMatch !== null) break;

    const fileMatch = /^\*\*\*\s*Update\s+File:\s+(.+?)\s*$/i.exec(line);
    if (fileMatch !== null) {
      flushFile(files, currentFile, currentHunk, currentRemovals, currentAdditions, filesFlushed);
      currentFile = { path: fileMatch[1].trim(), hunks: [] };
      currentHunk = undefined;
      currentRemovals = [];
      currentAdditions = [];
      continue;
    }

    const contextMatch = /^@@\s*(.+?)\s*@@$/i.exec(line);
    if (contextMatch !== null) {
      flushHunk(files, currentFile, currentHunk, currentRemovals, currentAdditions);
      currentHunk = { context: contextMatch[1].trim(), removals: [], additions: [] };
      currentRemovals = [];
      currentAdditions = [];
      continue;
    }

    if (currentHunk === undefined || currentFile === undefined) continue;

    if (line.startsWith("-") && !line.startsWith("--")) {
      currentRemovals.push(line.slice(1));
    } else if (line.startsWith("+") && !line.startsWith("++")) {
      currentAdditions.push(line.slice(1));
    } else {
      // Context line — flush current removal/addition pair
      if (currentRemovals.length > 0 || currentAdditions.length > 0) {
        currentHunk.removals = [...currentHunk.removals, ...currentRemovals];
        currentHunk.additions = [...currentHunk.additions, ...currentAdditions];
        currentRemovals = [];
        currentAdditions = [];
      }
    }
  }

  // Flush last file
  flushFile(files, currentFile, currentHunk, currentRemovals, currentAdditions, filesFlushed);

  return files;
}

function flushHunk(
  files: V4AFile[],
  currentFile: V4AFile | undefined,
  currentHunk: V4AHunk | undefined,
  removals: string[],
  additions: string[],
): void {
  if (currentHunk === undefined || currentFile === undefined) return;
  if (removals.length > 0 || additions.length > 0) {
    currentFile.hunks = [...currentFile.hunks, {
      context: currentHunk.context,
      removals: [...currentHunk.removals, ...removals],
      additions: [...currentHunk.additions, ...additions],
    }];
  } else if (currentHunk.removals.length > 0 || currentHunk.additions.length > 0) {
    currentFile.hunks = [...currentFile.hunks, currentHunk];
  }
}

function flushFile(
  files: V4AFile[],
  currentFile: V4AFile | undefined,
  currentHunk: V4AHunk | undefined,
  removals: string[],
  additions: string[],
  filesFlushed: Set<V4AFile>,
): void {
  if (currentFile === undefined) return;
  if (filesFlushed.has(currentFile)) return;
  filesFlushed.add(currentFile);
  flushHunk(files, currentFile, currentHunk, removals, additions);
  if (currentFile.hunks.length > 0) {
    files.push(currentFile);
  }
}

function applyV4AHunks(content: string, hunks: readonly V4AHunk[]): string {
  let result = content;
  for (const hunk of hunks) {
    const needle = [...hunk.removals].join("\n");
    if (needle.length === 0) {
      // Pure addition — insert additions after the context
      const lines = result.split("\n");
      const contextIdx = lines.findIndex((l) => l.includes(hunk.context));
      if (contextIdx !== -1) {
        lines.splice(contextIdx + 1, 0, ...hunk.additions);
        result = lines.join("\n");
      }
      continue;
    }
    // Find the removal block and replace with additions
    const idx = result.indexOf(needle);
    if (idx !== -1) {
      const before = result.slice(0, idx);
      const after = result.slice(idx + needle.length);
      result = before + [...hunk.additions].join("\n") + after;
    }
  }
  return result;
}

// ── Diff generation ──────────────────────────────────────────────

function buildDiff(path: string, original: string, patched: string, changeCount: number): string[] {
  const origLines = original.split("\n");
  const patchLines = patched.split("\n");

  const lines: string[] = [];
  lines.push(`--- ${path}`);
  lines.push(`+++ ${path}`);
  lines.push(`@@ -1,${String(origLines.length)} +1,${String(patchLines.length)} @@`);

  // Simple side-by-side diff: flag changed lines
  const maxLen = Math.max(origLines.length, patchLines.length);
  for (let i = 0; i < maxLen; i++) {
    const orig = origLines[i] ?? "";
    const patchedLine = patchLines[i] ?? "";
    if (orig === patchedLine) {
      lines.push(` ${orig}`);
    } else if (orig !== undefined && patchedLine !== undefined) {
      lines.push(`-${orig}`);
      lines.push(`+${patchedLine}`);
    } else if (orig !== undefined) {
      lines.push(`-${orig}`);
    } else {
      lines.push(`+${patchedLine}`);
    }
  }

  return lines;
}

// ── Syntax checking ──────────────────────────────────────────────

interface SyntaxResult {
  readonly ok: boolean;
  readonly error?: string;
}

async function checkSyntax(filePath: string): Promise<SyntaxResult> {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
    return checkTypeScriptSyntax(filePath);
  }
  if (filePath.endsWith(".json")) {
    return checkJsonSyntax(filePath);
  }
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    return checkYamlSyntax(filePath);
  }
  // No syntax check for unsupported file types
  return { ok: true };
}

async function checkTypeScriptSyntax(filePath: string): Promise<SyntaxResult> {
  try {
    const { stdout, stderr } = await execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false", filePath], {
      timeout: 15_000,
      maxBuffer: 512_000,
    });
    const output = [stdout, stderr].filter((s) => s.length > 0).join("\n").trim();
    if (output.length > 0) return { ok: false, error: output };
    return { ok: true };
  } catch (error: unknown) {
    // execFile throws on non-zero exit — capture stderr
    if (error instanceof Error && "stderr" in error) {
      return { ok: false, error: String((error as { stderr: unknown }).stderr) };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

async function checkJsonSyntax(filePath: string): Promise<SyntaxResult> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    JSON.parse(content);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function checkYamlSyntax(filePath: string): Promise<SyntaxResult> {
  try {
    const { load } = await import("js-yaml");
    const content = await fs.readFile(filePath, "utf8");
    load(content);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) };
  }
}

// ── Result helpers ───────────────────────────────────────────────

/**
 * Check whether the path is inside a known Hermes profile directory.
 */
function containsProfilePath(absolutePath: string): boolean {
  const pathLower = absolutePath.toLowerCase();
  return pathLower.includes("/hermes/") || pathLower.includes("\\hermes\\");
}

// ── Root path resolution ─────────────────────────────────────────

function resolveInsideRoot(rootPath: string, requested: string): string {
  const resolved = resolve(rootPath, requested);
  const rel = relative(rootPath, resolved);
  if (rel.startsWith("..") || rel.startsWith("/") || rel === "") {
    // Allow exact root access
    if (resolved !== rootPath) throw new Error(`path escapes delegated root: ${requested}`);
  }
  return resolved;
}

// ── Parameter helpers ────────────────────────────────────────────

function stringParam(params: unknown, name: string, fallback?: string): string {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    const value = (params as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
  }
  if (fallback !== undefined) return fallback;
  return "";
}

// ── Result helpers ───────────────────────────────────────────────

interface AgentToolResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(message: string): AgentToolResult {
  return { content: [{ type: "text" as const, text: message }], details: { ok: false, error: message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
