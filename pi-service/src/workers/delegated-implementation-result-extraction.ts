/** Extract structured delegated implementation results from bounded child output. */

import type {
  DelegatedArtifactHandle,
  DelegatedImplementationCheck,
  DelegatedImplementationResult,
  DelegatedResult,
  DelegationSpawnRequest,
} from "@pi-crew/core";

const MAX_IMPLEMENTATION_EXCERPT_CHARS = 1_600;

export function appendImplementationResultInstructions(
  task: string,
  spawnRequest: DelegationSpawnRequest,
): string {
  if (spawnRequest.expectedResultSchema !== "implementation") return task;
  const taskIds = spawnRequest.requiredEvidence?.taskIds ?? [];
  const required = [
    spawnRequest.requiredEvidence?.requireBranch === true ? "branch" : "",
    spawnRequest.requiredEvidence?.requireHeadCommit === true ? "headCommit" : "",
    spawnRequest.requiredEvidence?.requireTests === true ? "checks/tests" : "",
    spawnRequest.requiredEvidence?.requireWorkdirStatus === true ? "workdirStatus" : "",
    spawnRequest.requiredEvidence?.requireEvidenceHandles === true ? "artifact/Den handles" : "",
  ].filter(Boolean);
  const taskLine =
    taskIds.length > 0 ? `Required task ids: ${taskIds.join(", ")}` : "Include taskId when known.";
  const evidenceLine =
    required.length > 0
      ? `Required evidence: ${required.join(", ")}`
      : "Return all implementation evidence you have.";
  return `${task}\n\nYou are running in delegated implementation mode. ${taskLine} ${evidenceLine}\nReturn your final answer as a single JSON object inside <delegated_implementation_result>...</delegated_implementation_result> tags. Do not put prose inside the tags. Shape:\n{\n  "status": "implemented" | "no_code_change" | "blocked" | "failed" | "insufficient_evidence",\n  "taskId": "2401",\n  "branch": "feature/branch",\n  "headCommit": "git sha",\n  "noCodeChangeRationale": "only for no_code_change",\n  "changedFiles": ["path/to/file.ts"],\n  "artifactHandles": [{ "type": "code_change" | "file" | "den_message" | "den_document" | "inventory_note", "description": "...", "commitSha": "...", "filePath": "...", "messageId": 123, "slug": "..." }],\n  "checks": [{ "command": "npm test -- ...", "status": "passed" | "failed" | "not_run", "summary": "..." }],\n  "workdirStatus": { "state": "clean" | "dirty_expected" | "dirty_unexpected", "summary": "...", "dirtyFiles": ["optional"] },\n  "denHandoffHandles": [{ "type": "den_message", "messageId": 123, "description": "implementation packet" }]\n}\nSet status to implemented only when branch/head/files/checks/workdir/handle evidence is present, or no_code_change only with an explicit rationale and evidence handles.`;
}

export function attachExtractedImplementationResult(
  result: DelegatedResult,
  spawnRequest: DelegationSpawnRequest,
  text: string | undefined,
): DelegatedResult {
  if (result.implementation !== undefined) return result;
  if (spawnRequest.expectedResultSchema !== "implementation") return result;
  const implementation = text === undefined ? null : extractImplementationResult(text);
  if (implementation === null) {
    return {
      ...result,
      safeExcerpt:
        result.safeExcerpt ??
        bounded(text ?? "No assistant text was available for delegated implementation extraction."),
    };
  }
  return {
    ...result,
    implementation,
    evidenceChecked: true,
    safeExcerpt: result.safeExcerpt ?? bounded(JSON.stringify(implementation, null, 2)),
    artifacts: result.artifacts ?? [
      ...implementation.artifactHandles,
      ...(implementation.denHandoffHandles ?? []),
    ],
  };
}

export function extractImplementationResult(text: string): DelegatedImplementationResult | null {
  const tagged = extractTaggedJson(text);
  const parsed = parseJsonObject(tagged ?? text.trim());
  return isImplementationResult(parsed) ? parsed : null;
}

function extractTaggedJson(text: string): string | null {
  const match =
    /<delegated_implementation_result>\s*([\s\S]*?)\s*<\/delegated_implementation_result>/u.exec(
      text,
    );
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

function isImplementationResult(value: unknown): value is DelegatedImplementationResult {
  if (!isRecord(value)) return false;
  return (
    validImplementationStatus(value["status"]) &&
    (value["taskId"] === undefined || typeof value["taskId"] === "string") &&
    (value["branch"] === undefined || typeof value["branch"] === "string") &&
    (value["headCommit"] === undefined || typeof value["headCommit"] === "string") &&
    (value["noCodeChangeRationale"] === undefined ||
      typeof value["noCodeChangeRationale"] === "string") &&
    (value["changedFiles"] === undefined || isStringArray(value["changedFiles"])) &&
    isArtifactArray(value["artifactHandles"]) &&
    Array.isArray(value["checks"]) &&
    value["checks"].every(isCheck) &&
    (value["workdirStatus"] === undefined || isWorkdirStatus(value["workdirStatus"])) &&
    (value["denHandoffHandles"] === undefined || isArtifactArray(value["denHandoffHandles"]))
  );
}

function isCheck(value: unknown): value is DelegatedImplementationCheck {
  if (!isRecord(value)) return false;
  return (
    typeof value["command"] === "string" &&
    validCheckStatus(value["status"]) &&
    typeof value["summary"] === "string"
  );
}

function isWorkdirStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    validWorkdirState(value["state"]) &&
    typeof value["summary"] === "string" &&
    (value["dirtyFiles"] === undefined || isStringArray(value["dirtyFiles"]))
  );
}

function isArtifactArray(value: unknown): value is readonly DelegatedArtifactHandle[] {
  return Array.isArray(value) && value.every(isArtifact);
}

function isArtifact(value: unknown): value is DelegatedArtifactHandle {
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

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validImplementationStatus(value: unknown): boolean {
  return (
    value === "implemented" ||
    value === "no_code_change" ||
    value === "blocked" ||
    value === "failed" ||
    value === "insufficient_evidence"
  );
}

function validCheckStatus(value: unknown): boolean {
  return value === "passed" || value === "failed" || value === "not_run";
}

function validWorkdirState(value: unknown): boolean {
  return value === "clean" || value === "dirty_expected" || value === "dirty_unexpected";
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
  if (text.length <= MAX_IMPLEMENTATION_EXCERPT_CHARS) return text;
  return `${text.slice(0, MAX_IMPLEMENTATION_EXCERPT_CHARS)}… [truncated]`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
