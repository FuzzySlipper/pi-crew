/** Opt-in context diagnostic attribution and redacted report generation. */

import { createHash } from "node:crypto";
import type { DiagnosticEventRecord } from "./types.js";

export type ContextDiagnosticCategory =
  | "user_prompt"
  | "assistant_response"
  | "tool_input"
  | "tool_result"
  | "direct_file_read"
  | "delegated_helper_output";

export interface ContextDiagnosticInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userMessage: string;
  readonly assistantMessage: string;
  readonly events: readonly DiagnosticEventRecord[];
  readonly maxSampleChars?: number;
  readonly topN?: number;
}

export interface ContextDiagnosticContributor {
  readonly category: ContextDiagnosticCategory;
  readonly label: string;
  readonly estimatedBytes: number;
  readonly sample: string;
  readonly hash: string;
  readonly handle: string;
}

export interface ContextDiagnosticCategorySummary {
  readonly category: ContextDiagnosticCategory;
  readonly estimatedBytes: number;
  readonly contributorCount: number;
}

export interface ContextDiagnosticReport {
  readonly sessionId: string;
  readonly turnId: string;
  readonly generatedAt: string;
  readonly totals: {
    readonly estimatedBytes: number;
    readonly contributorCount: number;
  };
  readonly categories: readonly ContextDiagnosticCategorySummary[];
  readonly topContributors: readonly ContextDiagnosticContributor[];
  readonly repeatedHashes: readonly {
    readonly hash: string;
    readonly count: number;
    readonly estimatedBytes: number;
  }[];
  readonly recommendations: readonly string[];
  readonly redaction: {
    readonly rawContentStored: false;
    readonly sampleMaxChars: number;
    readonly secretPatternsRedacted: readonly string[];
  };
}

interface DraftContributor {
  readonly category: ContextDiagnosticCategory;
  readonly label: string;
  readonly raw: string;
  readonly handle: string;
}

const SECRET_PATTERN_LABELS = [
  "token assignments",
  "URL credentials",
  "secret-like key/value pairs",
];

export function createContextDiagnosticReport(
  input: ContextDiagnosticInput,
): ContextDiagnosticReport {
  const maxSampleChars = input.maxSampleChars ?? 240;
  const contributors = normalizeContributors(input).map(
    (contributor): ContextDiagnosticContributor => {
      const redacted = redact(contributor.raw);
      return {
        category: contributor.category,
        label: contributor.label,
        estimatedBytes: Buffer.byteLength(contributor.raw, "utf8"),
        sample: truncate(redacted, maxSampleChars),
        hash: sha256(redacted),
        handle: contributor.handle,
      };
    },
  );
  const categories = summarizeCategories(contributors);
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    generatedAt: new Date().toISOString(),
    totals: {
      estimatedBytes: contributors.reduce((sum, item) => sum + item.estimatedBytes, 0),
      contributorCount: contributors.length,
    },
    categories,
    topContributors: [...contributors]
      .sort((left, right) => right.estimatedBytes - left.estimatedBytes)
      .slice(0, input.topN ?? 10),
    repeatedHashes: repeatedHashes(contributors),
    recommendations: recommendations(categories),
    redaction: {
      rawContentStored: false,
      sampleMaxChars: maxSampleChars,
      secretPatternsRedacted: SECRET_PATTERN_LABELS,
    },
  };
}

function normalizeContributors(input: ContextDiagnosticInput): DraftContributor[] {
  const contributors: DraftContributor[] = [
    {
      category: "user_prompt",
      label: "diagnostic user message",
      raw: input.userMessage,
      handle: `turn:${input.turnId}:user`,
    },
    {
      category: "assistant_response",
      label: "assistant response",
      raw: input.assistantMessage,
      handle: `turn:${input.turnId}:assistant`,
    },
  ];
  for (const event of input.events) {
    const payload = asRecord(event.payload);
    if (
      payload?.["sessionId"] !== input.sessionId &&
      payload?.["parentSessionId"] !== input.sessionId
    )
      continue;
    const toolName =
      readString(payload, "toolName") ?? readString(payload, "helperName") ?? "unknown_tool";
    if (event.event === "tool.called") {
      contributors.push({
        category: "tool_input",
        label: `${toolName} input`,
        raw: stringify(payload["params"] ?? payload),
        handle: `event:${String(event.sequence)}`,
      });
    }
    if (event.event === "tool.completed") {
      const category = classifyToolResult(toolName);
      contributors.push({
        category,
        label: `${toolName} result`,
        raw: stringify(payload["result"] ?? payload),
        handle: `event:${String(event.sequence)}`,
      });
    }
  }
  return contributors;
}

function classifyToolResult(toolName: string): ContextDiagnosticCategory {
  if (["read_file", "search_files", "browser_extract", "web_extract"].includes(toolName))
    return "direct_file_read";
  if (["scout_codebase", "summarize_files", "find_relevant_paths"].includes(toolName)) {
    return "delegated_helper_output";
  }
  return "tool_result";
}

function summarizeCategories(
  contributors: readonly ContextDiagnosticContributor[],
): ContextDiagnosticCategorySummary[] {
  const byCategory = new Map<ContextDiagnosticCategory, { bytes: number; count: number }>();
  for (const contributor of contributors) {
    const existing = byCategory.get(contributor.category) ?? { bytes: 0, count: 0 };
    byCategory.set(contributor.category, {
      bytes: existing.bytes + contributor.estimatedBytes,
      count: existing.count + 1,
    });
  }
  return [...byCategory.entries()]
    .map(([category, value]) => ({
      category,
      estimatedBytes: value.bytes,
      contributorCount: value.count,
    }))
    .sort((left, right) => right.estimatedBytes - left.estimatedBytes);
}

function repeatedHashes(contributors: readonly ContextDiagnosticContributor[]) {
  const byHash = new Map<string, { count: number; bytes: number }>();
  for (const contributor of contributors) {
    const existing = byHash.get(contributor.hash) ?? { count: 0, bytes: 0 };
    byHash.set(contributor.hash, {
      count: existing.count + 1,
      bytes: existing.bytes + contributor.estimatedBytes,
    });
  }
  return [...byHash.entries()]
    .filter(([, value]) => value.count > 1)
    .map(([hash, value]) => ({ hash, count: value.count, estimatedBytes: value.bytes }))
    .sort((left, right) => right.estimatedBytes - left.estimatedBytes);
}

function recommendations(categories: readonly ContextDiagnosticCategorySummary[]): string[] {
  const output: string[] = [];
  const directRead = categories.find((category) => category.category === "direct_file_read");
  const helper = categories.find((category) => category.category === "delegated_helper_output");
  if (directRead !== undefined && directRead.estimatedBytes > (helper?.estimatedBytes ?? 0)) {
    output.push(
      "Large direct file reads dominate this turn; consider helper tools or file-range summaries.",
    );
  }
  if (helper !== undefined) {
    output.push(
      "Delegated helper output is present; compare its size against direct reads before expanding parent context.",
    );
  }
  if (output.length === 0)
    output.push("No dominant context-waste pattern detected in this bounded report.");
  return output;
}

function redact(value: string): string {
  return value
    .replace(/[A-Za-z0-9._%+-]+:[^\s@/]+@/g, "[REDACTED]@")
    .replace(/\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]")
    .replace(/postgres:\/\/[^\s]+/gi, "postgres://[REDACTED]");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}… [truncated]`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
  return null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
