/** Extract structured delegated review results from bounded child output. */

import type { DelegatedResult, DelegationSpawnRequest, DelegatedReviewResult } from "@pi-crew/core";

const MAX_REVIEW_EXCERPT_CHARS = 1_600;

export function appendReviewResultInstructions(
  task: string,
  spawnRequest: DelegationSpawnRequest,
): string {
  if (!requiresReviewResult(spawnRequest)) return task;
  const taskIds = spawnRequest.requiredEvidence?.taskIds ?? [];
  const taskLine =
    taskIds.length > 0
      ? `Required task decisions: ${taskIds.join(", ")}`
      : "Return decisions for every reviewed task.";
  return `${task}\n\nYou are running in delegated review mode. ${taskLine}\nReturn your final answer as a single JSON object inside <delegated_review_result>...</delegated_review_result> tags. Do not put prose inside the tags. Shape:\n{\n  "status": "accepted" | "changes_requested" | "blocked" | "insufficient_evidence",\n  "evidenceHandles": [{ "type": "den_message" | "den_document" | "code_change" | "file" | "inventory_note", "description": "...", "messageId": 123, "slug": "...", "filePath": "...", "commitSha": "..." }],\n  "taskDecisions": [{ "taskId": "2344", "decision": "accepted" | "changes_requested" | "blocked" | "insufficient_evidence", "summary": "...", "evidenceHandles": [...] }],\n  "findings": [{ "taskId": "2344", "severity": "blocker" | "major" | "minor" | "info", "category": "correctness", "summary": "...", "location": "optional" }]\n}\nSet status to accepted only if all task decisions are accepted and evidence handles are present.`;
}

export function attachExtractedReviewResult(
  result: DelegatedResult,
  spawnRequest: DelegationSpawnRequest,
  text: string | undefined,
): DelegatedResult {
  if (result.review !== undefined) return result;
  if (!requiresReviewResult(spawnRequest)) return result;
  const review = text === undefined ? null : extractReviewResult(text);
  if (review === null) {
    return {
      ...result,
      safeExcerpt:
        result.safeExcerpt ??
        bounded(text ?? "No assistant text was available for delegated review extraction."),
    };
  }
  return {
    ...result,
    review,
    evidenceChecked: true,
    safeExcerpt: result.safeExcerpt ?? bounded(JSON.stringify(review, null, 2)),
    artifacts: result.artifacts ?? review.evidenceHandles,
  };
}

export function extractReviewResult(text: string): DelegatedReviewResult | null {
  const tagged = extractTaggedJson(text);
  const parsed = parseJsonObject(tagged ?? text.trim());
  return isReviewResult(parsed) ? parsed : null;
}

function requiresReviewResult(spawnRequest: DelegationSpawnRequest): boolean {
  return (
    spawnRequest.expectedResultSchema === "review" ||
    (spawnRequest.expectedResultSchema === undefined && spawnRequest.requiredEvidence !== undefined)
  );
}

export function latestAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!isRecord(candidate) || candidate["role"] !== "assistant") continue;
    const content = candidate["content"];
    const text = contentToText(content);
    if (text !== undefined && text.trim() !== "") return text;
  }
  return undefined;
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block) => {
    if (!isRecord(block) || block["type"] !== "text") return [];
    const text = block["text"];
    return typeof text === "string" ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractTaggedJson(text: string): string | null {
  const match = /<delegated_review_result>\s*([\s\S]*?)\s*<\/delegated_review_result>/u.exec(text);
  return match?.[1] ?? null;
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function isReviewResult(value: unknown): value is DelegatedReviewResult {
  if (!isRecord(value)) return false;
  return (
    validStatus(value["status"]) &&
    isArtifactArray(value["evidenceHandles"]) &&
    Array.isArray(value["taskDecisions"]) &&
    value["taskDecisions"].every(isTaskDecision) &&
    (value["findings"] === undefined ||
      (Array.isArray(value["findings"]) && value["findings"].every(isFinding)))
  );
}

function isTaskDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value["taskId"] === "string" &&
    validStatus(value["decision"]) &&
    typeof value["summary"] === "string" &&
    isArtifactArray(value["evidenceHandles"]) &&
    (value["findings"] === undefined ||
      (Array.isArray(value["findings"]) && value["findings"].every(isFinding)))
  );
}

function isFinding(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value["taskId"] === undefined || typeof value["taskId"] === "string") &&
    validSeverity(value["severity"]) &&
    typeof value["category"] === "string" &&
    typeof value["summary"] === "string" &&
    (value["location"] === undefined || typeof value["location"] === "string")
  );
}

function isArtifactArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isArtifact);
}

function isArtifact(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    validArtifactType(value["type"]) &&
    typeof value["description"] === "string" &&
    (value["messageId"] === undefined || typeof value["messageId"] === "number") &&
    (value["slug"] === undefined || typeof value["slug"] === "string") &&
    (value["filePath"] === undefined || typeof value["filePath"] === "string") &&
    (value["commitSha"] === undefined || typeof value["commitSha"] === "string")
  );
}

function validStatus(value: unknown): boolean {
  return (
    value === "accepted" ||
    value === "changes_requested" ||
    value === "blocked" ||
    value === "insufficient_evidence"
  );
}

function validSeverity(value: unknown): boolean {
  return value === "blocker" || value === "major" || value === "minor" || value === "info";
}

function validArtifactType(value: unknown): boolean {
  return (
    value === "den_document" ||
    value === "den_message" ||
    value === "code_change" ||
    value === "file" ||
    value === "inventory_note"
  );
}

function bounded(text: string): string {
  if (text.length <= MAX_REVIEW_EXCERPT_CHARS) return text;
  return `${text.slice(0, MAX_REVIEW_EXCERPT_CHARS)}… [truncated]`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
