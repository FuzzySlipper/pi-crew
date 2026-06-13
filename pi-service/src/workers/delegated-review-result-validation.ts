/** Harness-level validation for delegated review-mode child results. */

import type {
  DelegatedArtifactHandle,
  DelegatedResult,
  DelegationSpawnRequest,
  DelegatedReviewFinding,
  DelegatedReviewTaskDecision,
} from "@pi-crew/core";

const REVIEW_FAILURE_SUMMARY = "Delegated review result failed evidence validation";

export function validateDelegatedReviewResult(
  result: DelegatedResult,
  spawnRequest: DelegationSpawnRequest,
): DelegatedResult {
  if (!requiresReviewValidation(spawnRequest)) return result;
  if (result.outcome !== "success") return result;
  const failures = collectReviewValidationFailures(result, spawnRequest);
  if (failures.length === 0) return result;
  return {
    ...result,
    outcome: "failure",
    summary: REVIEW_FAILURE_SUMMARY,
    failureCategory: "insufficient_evidence",
    evidenceChecked: false,
    recoveryGuidance:
      "Retry with delegated review mode and require a structured review result containing per-task decisions, evidence handles, and findings/verdicts.",
    safeExcerpt: formatValidationFailures(failures),
  };
}

function requiresReviewValidation(spawnRequest: DelegationSpawnRequest): boolean {
  return (
    spawnRequest.expectedResultSchema === "review" ||
    (spawnRequest.expectedResultSchema === undefined && spawnRequest.requiredEvidence !== undefined)
  );
}

function collectReviewValidationFailures(
  result: DelegatedResult,
  spawnRequest: DelegationSpawnRequest,
): string[] {
  const failures: string[] = [];
  const review = result.review;
  if (review === undefined) {
    failures.push("missing structured review result");
    return failures;
  }
  if (!validReviewStatus(review.status)) failures.push("review status is invalid");
  if (!hasEvidence(review.evidenceHandles)) failures.push("review evidence handles are missing");
  if (review.taskDecisions.length === 0) failures.push("per-task review decisions are missing");
  const taskIds = spawnRequest.requiredEvidence?.taskIds ?? [];
  for (const taskId of taskIds) {
    if (!review.taskDecisions.some((decision) => decision.taskId === taskId)) {
      failures.push(`missing per-task review decision for ${taskId}`);
    }
  }
  for (const decision of review.taskDecisions) {
    failures.push(...validateTaskDecision(decision));
  }
  for (const finding of review.findings ?? []) {
    failures.push(...validateFinding(finding, "review finding"));
  }
  if ((result.artifacts?.length ?? 0) === 0 && !hasEvidence(review.evidenceHandles)) {
    failures.push("artifact handles and review evidence handles are both empty");
  }
  return failures;
}

function validateTaskDecision(decision: DelegatedReviewTaskDecision): string[] {
  const failures: string[] = [];
  if (decision.taskId.trim() === "") failures.push("task decision taskId is required");
  if (!validReviewStatus(decision.decision))
    failures.push(`decision for ${decision.taskId} is invalid`);
  if (decision.summary.trim() === "")
    failures.push(`decision summary for ${decision.taskId} is required`);
  if (!hasEvidence(decision.evidenceHandles)) {
    failures.push(`evidence handles for ${decision.taskId} are missing`);
  }
  for (const finding of decision.findings ?? []) {
    failures.push(...validateFinding(finding, `finding for ${decision.taskId}`));
  }
  return failures;
}

function validateFinding(finding: DelegatedReviewFinding, label: string): string[] {
  const failures: string[] = [];
  if (!validFindingSeverity(finding.severity)) failures.push(`${label} severity is invalid`);
  if (finding.category.trim() === "") failures.push(`${label} category is required`);
  if (finding.summary.trim() === "") failures.push(`${label} summary is required`);
  return failures;
}

function hasEvidence(handles: readonly DelegatedArtifactHandle[] | undefined): boolean {
  return handles !== undefined && handles.length > 0;
}

function validReviewStatus(value: string): boolean {
  return (
    value === "accepted" ||
    value === "changes_requested" ||
    value === "blocked" ||
    value === "insufficient_evidence"
  );
}

function validFindingSeverity(value: string): boolean {
  return value === "blocker" || value === "major" || value === "minor" || value === "info";
}

function formatValidationFailures(failures: readonly string[]): string {
  return `Delegated review evidence validation failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`;
}
