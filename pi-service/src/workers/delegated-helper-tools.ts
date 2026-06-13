/** Delegated assistant helper tools for context-frugal prime workflows. */

import type {
  DelegatedArtifactHandle,
  DelegatedResult,
  DelegationConstraints,
  DelegationLineage,
  EffectiveDelegationRuntime,
  ExecutionPolicy,
} from "@pi-crew/core";
import type { AgentTool, AgentToolResult } from "./guarded-tool-types.js";
import type {
  DelegatedSpawnCorrelation,
  DelegatedSpawnInput,
} from "./delegated-spawn-lifecycle.js";
import type { DelegatedSpawnLifecyclePort } from "./delegated-spawn-tool.js";

export type DelegatedHelperName = "scout_codebase" | "summarize_files" | "find_relevant_paths";
export type DelegatedHelperStatus = "ok" | "degraded" | "partial";

export interface DelegatedHelperPathHandle {
  readonly path: string;
  readonly ranges?: readonly string[];
  readonly why?: string;
  readonly confidence?: "high" | "medium" | "low";
}

export interface DelegatedHelperToolResult {
  readonly helperName: DelegatedHelperName;
  readonly status: DelegatedHelperStatus;
  readonly outcome: DelegatedResult["outcome"];
  readonly summary: string;
  readonly childSessionId: string;
  readonly policyId: string;
  readonly paths: readonly DelegatedHelperPathHandle[];
  readonly recommendedNextReads: readonly string[];
  readonly risks: readonly string[];
  readonly warnings: readonly string[];
  readonly safeExcerpt?: string;
  readonly artifacts?: readonly DelegatedArtifactHandle[];
  readonly toolsUsed?: readonly string[];
  readonly durationMs?: number;
  readonly turnsUsed?: number;
  readonly tokensConsumed?: number;
  readonly evidenceChecked?: boolean;
}

export interface DelegatedHelperToolOptions {
  readonly lifecycle: DelegatedSpawnLifecyclePort;
  readonly parentSessionId: string;
  readonly parentPolicy: ExecutionPolicy;
  readonly parentDelegationConstraints: DelegationConstraints;
  readonly parentLineage?: DelegationLineage | null;
  readonly parentRuntime: EffectiveDelegationRuntime;
  readonly allowedRuntimes?: readonly EffectiveDelegationRuntime[];
  readonly correlation?: DelegatedSpawnCorrelation;
}

interface HelperSpec {
  readonly name: DelegatedHelperName;
  readonly label: string;
  readonly description: string;
}

const MAX_SAFE_EXCERPT_CHARS = 1_600;
const MAX_SUMMARY_CHARS = 700;
const MAX_PATHS = 12;
const MAX_LIST_ITEMS = 12;

const HELPER_SPECS: readonly HelperSpec[] = [
  {
    name: "scout_codebase",
    label: "Scout codebase",
    description:
      "Spawn an assistant helper to inspect code/docs and return compact path/range handles, risks, and next reads.",
  },
  {
    name: "summarize_files",
    label: "Summarize files",
    description:
      "Spawn an assistant helper to summarize selected files/ranges without returning raw large file contents.",
  },
  {
    name: "find_relevant_paths",
    label: "Find relevant paths",
    description:
      "Spawn an assistant helper to find likely paths and concise reasons for a prime workflow objective.",
  },
];

export function createDelegationHelperTools(options: DelegatedHelperToolOptions): AgentTool[] {
  return HELPER_SPECS.map((spec) => createDelegationHelperTool(spec, options));
}

function createDelegationHelperTool(
  spec: HelperSpec,
  options: DelegatedHelperToolOptions,
): AgentTool {
  return {
    label: spec.label,
    name: spec.name,
    description: spec.description,
    parameters: helperParameters(spec.name),
    execute: async (_toolCallId, params): Promise<AgentToolResult> => {
      const spawnInput = buildSpawnInput(spec.name, params, options);
      const spawnResult = await options.lifecycle.spawn(spawnInput);
      if (!spawnResult.ok) {
        return {
          content: [
            { type: "text", text: `${spawnResult.error.code}: ${spawnResult.error.message}` },
          ],
          details: {
            ok: false,
            code: spawnResult.error.code,
            message: spawnResult.error.message,
            detail: spawnResult.error.detail,
          },
        };
      }
      const result = normalizeHelperResult(spec.name, spawnResult.value);
      return {
        content: [{ type: "text", text: formatHelperResult(result) }],
        details: { ok: true, result },
      };
    },
  };
}

function helperParameters(name: DelegatedHelperName): AgentTool["parameters"] {
  const shared = {
    objective: {
      type: "string",
      description: "Prime objective or question for this assistant helper.",
    },
    scope: {
      type: "string",
      description: "Optional package, directory, task id, doc slug, or repo scope.",
    },
    maxFiles: { type: "number", minimum: 1, maximum: MAX_PATHS },
    maxOutputChars: { type: "number", minimum: 300, maximum: MAX_SAFE_EXCERPT_CHARS },
  };
  if (name === "summarize_files") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["files"],
      properties: {
        ...shared,
        question: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
              path: { type: "string" },
              ranges: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    } as AgentTool["parameters"];
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["objective"],
    properties: {
      ...shared,
      includeTests: { type: "boolean" },
    },
  } as AgentTool["parameters"];
}

function buildSpawnInput(
  name: DelegatedHelperName,
  params: unknown,
  options: DelegatedHelperToolOptions,
): DelegatedSpawnInput {
  const task = buildHelperTask(name, params);
  return {
    parentSessionId: options.parentSessionId,
    task,
    parentPolicy: options.parentPolicy,
    parentDelegationConstraints: options.parentDelegationConstraints,
    parentLineage: options.parentLineage,
    parentRuntime: options.parentRuntime,
    allowedRuntimes: options.allowedRuntimes,
    correlation: options.correlation,
    spawnRequest: {
      task,
      modelSelection: { profileId: options.parentRuntime.profileId },
    },
  };
}

function buildHelperTask(name: DelegatedHelperName, params: unknown): string {
  const input = isRecord(params) ? params : {};
  const objective =
    stringField(input, "objective") ?? stringField(input, "question") ?? "bounded helper task";
  const scope = stringField(input, "scope");
  const maxFiles = numberField(input, "maxFiles") ?? 8;
  const files = filesField(input["files"]);
  const fileLine = files.length === 0 ? "" : `\nFiles/ranges: ${JSON.stringify(files)}`;
  const scopeLine = scope === undefined ? "" : `\nScope: ${scope}`;
  return [
    `${name} assistant helper task.`,
    `Objective: ${objective}`,
    scopeLine.trim(),
    `Max paths/files to return: ${Math.min(maxFiles, MAX_PATHS)}`,
    fileLine.trim(),
    "Return a compact JSON object if possible with summary, paths/ranges, risks, recommendedNextReads, and confidence.",
    "Do not modify files. Do not dump full file contents. It is acceptable to return partial/degraded findings with uncertainty.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function normalizeHelperResult(
  helperName: DelegatedHelperName,
  result: DelegatedResult,
): DelegatedHelperToolResult {
  const source = result.safeExcerpt ?? result.summary;
  const parsed = parseHelperPayload(source);
  const warnings: string[] = [];
  if (parsed.aliasesUsed) warnings.push("normalized helper report aliases");
  const excerpt = sanitizeAndTruncate(source, warnings);
  const paths = boundPaths(parsed.paths);
  const status =
    result.outcome === "success"
      ? parsed.degraded || paths.length === 0
        ? "degraded"
        : "ok"
      : "partial";
  return {
    helperName,
    status,
    outcome: result.outcome,
    summary: truncateText(parsed.summary ?? result.summary, MAX_SUMMARY_CHARS),
    childSessionId: result.childSessionId,
    policyId: result.policyId,
    paths,
    recommendedNextReads: boundStrings(parsed.recommendedNextReads),
    risks: boundStrings(parsed.risks),
    warnings,
    ...(excerpt === undefined ? {} : { safeExcerpt: excerpt }),
    ...(result.artifacts === undefined
      ? {}
      : { artifacts: result.artifacts.slice(0, MAX_LIST_ITEMS) }),
    ...(result.toolsUsed === undefined
      ? {}
      : { toolsUsed: result.toolsUsed.slice(0, MAX_LIST_ITEMS) }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result.turnsUsed === undefined ? {} : { turnsUsed: result.turnsUsed }),
    ...(result.tokensConsumed === undefined ? {} : { tokensConsumed: result.tokensConsumed }),
    ...(result.evidenceChecked === undefined ? {} : { evidenceChecked: result.evidenceChecked }),
  };
}

interface ParsedHelperPayload {
  readonly summary?: string;
  readonly paths: readonly DelegatedHelperPathHandle[];
  readonly risks: readonly string[];
  readonly recommendedNextReads: readonly string[];
  readonly aliasesUsed: boolean;
  readonly degraded: boolean;
}

function parseHelperPayload(text: string): ParsedHelperPayload {
  const jsonText = extractJsonObject(text);
  if (jsonText === null)
    return { paths: [], risks: [], recommendedNextReads: [], aliasesUsed: false, degraded: true };
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (!isRecord(parsed)) return emptyDegraded();
    return parsePayloadRecord(parsed);
  } catch {
    return emptyDegraded();
  }
}

function parsePayloadRecord(record: Readonly<Record<string, unknown>>): ParsedHelperPayload {
  let aliasesUsed = false;
  const summary = stringField(record, "summary") ?? stringField(record, "answer");
  if (record["answer"] !== undefined && record["summary"] === undefined) aliasesUsed = true;
  const pathCandidates =
    arrayField(record["paths"]) ??
    arrayField(record["candidatePaths"]) ??
    pathGroups(record["pathGroups"]);
  if (record["candidatePaths"] !== undefined || record["pathGroups"] !== undefined)
    aliasesUsed = true;
  return {
    summary,
    paths: (pathCandidates ?? []).map((entry) => parsePath(entry)).filter(isPathHandle),
    risks: stringArray(record["risks"]),
    recommendedNextReads: stringArray(record["recommendedNextReads"] ?? record["next"]),
    aliasesUsed,
    degraded: aliasesUsed,
  };
}

function parsePath(value: unknown): DelegatedHelperPathHandle | null {
  if (!isRecord(value)) return null;
  const path = stringField(value, "path") ?? stringField(value, "file");
  if (path === undefined) return null;
  const range = stringField(value, "range") ?? stringField(value, "lineRange");
  const ranges = stringArray(value["ranges"] ?? range);
  const confidence = value["confidence"];
  return {
    path,
    ...(ranges.length === 0 ? {} : { ranges }),
    ...(stringField(value, "why") === undefined ? {} : { why: stringField(value, "why") }),
    ...(confidence === "high" || confidence === "medium" || confidence === "low"
      ? { confidence }
      : {}),
  };
}

function pathGroups(value: unknown): readonly unknown[] | null {
  const groups = arrayField(value);
  if (groups === null) return null;
  return groups.flatMap((group) => (isRecord(group) ? (arrayField(group["paths"]) ?? []) : []));
}

function emptyDegraded(): ParsedHelperPayload {
  return { paths: [], risks: [], recommendedNextReads: [], aliasesUsed: false, degraded: true };
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function formatHelperResult(result: DelegatedHelperToolResult): string {
  return `Delegated helper result\n${JSON.stringify(result, null, 2)}`;
}

function sanitizeAndTruncate(text: string, warnings: string[]): string | undefined {
  if (text.length === 0) return undefined;
  const sanitized = text.replace(/RAW_TRANSCRIPT_SHOULD_NOT_APPEAR/g, "[redacted]");
  const truncated = truncateText(sanitized, MAX_SAFE_EXCERPT_CHARS);
  if (truncated !== sanitized) warnings.push("helper output was truncated");
  return truncated;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [truncated]`;
}

function boundPaths(
  paths: readonly DelegatedHelperPathHandle[],
): readonly DelegatedHelperPathHandle[] {
  return paths.slice(0, MAX_PATHS);
}

function boundStrings(values: readonly string[]): readonly string[] {
  return values.map((value) => truncateText(value, 220)).slice(0, MAX_LIST_ITEMS);
}

function stringArray(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function filesField(value: unknown): readonly unknown[] {
  return arrayField(value) ?? [];
}

function arrayField(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPathHandle(value: DelegatedHelperPathHandle | null): value is DelegatedHelperPathHandle {
  return value !== null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
