/** Harness-level validation for delegated implementation-mode child results. */

import type {
  DelegatedArtifactHandle,
  DelegatedImplementationCheck,
  DelegatedImplementationResult,
  DelegatedResult,
  DelegationSpawnRequest,
} from "@pi-crew/core";

const IMPLEMENTATION_FAILURE_SUMMARY = "Delegated implementation result failed evidence validation";

export function validateDelegatedImplementationResult(
  result: DelegatedResult,
  spawnRequest: DelegationSpawnRequest,
): DelegatedResult {
  if (!requiresImplementationValidation(spawnRequest)) return result;
  if (result.outcome !== "success") return result;
  const failures = collectImplementationValidationFailures(result, spawnRequest);
  if (failures.length === 0) return result;
  return {
    ...result,
    outcome: "failure",
    summary: IMPLEMENTATION_FAILURE_SUMMARY,
    failureCategory: "insufficient_evidence",
    evidenceChecked: false,
    recoveryGuidance:
      "Retry with delegated implementation mode and require structured implementation evidence: branch/head, changed files or no-code rationale, checks, workdir status, and handoff/artifact handles.",
    safeExcerpt: formatValidationFailures(failures),
  };
}

function requiresImplementationValidation(spawnRequest: DelegationSpawnRequest): boolean {
  return spawnRequest.expectedResultSchema === "implementation";
}

function collectImplementationValidationFailures(
  result: DelegatedResult,
  spawnRequest: DelegationSpawnRequest,
): string[] {
  const implementation = result.implementation;
  if (implementation === undefined) return ["missing structured implementation result"];
  const failures: string[] = [];
  if (!validImplementationStatus(implementation.status))
    failures.push("implementation status is invalid");
  failures.push(...validateTaskContext(implementation, spawnRequest));
  failures.push(...validateCodeEvidence(implementation, spawnRequest));
  failures.push(...validateCheckEvidence(implementation, spawnRequest));
  failures.push(...validateWorkdirEvidence(implementation, spawnRequest));
  failures.push(...validateHandleEvidence(implementation, spawnRequest));
  return failures;
}

function validateTaskContext(
  implementation: DelegatedImplementationResult,
  spawnRequest: DelegationSpawnRequest,
): string[] {
  const taskIds = spawnRequest.requiredEvidence?.taskIds ?? [];
  if (taskIds.length === 0) return [];
  if (implementation.taskId === undefined || implementation.taskId.trim() === "") {
    return ["implementation taskId is required"];
  }
  return taskIds.includes(implementation.taskId)
    ? []
    : [`implementation taskId ${implementation.taskId} is not in required task ids`];
}

function validateCodeEvidence(
  implementation: DelegatedImplementationResult,
  spawnRequest: DelegationSpawnRequest,
): string[] {
  if (implementation.status === "no_code_change") {
    return validateNoCodeChangeEvidence(implementation);
  }
  const failures: string[] = [];
  if (spawnRequest.requiredEvidence?.requireBranch === true && blank(implementation.branch)) {
    failures.push("implementation branch is required");
  }
  if (
    spawnRequest.requiredEvidence?.requireHeadCommit === true &&
    blank(implementation.headCommit)
  ) {
    failures.push("implementation headCommit is required");
  }
  if (
    (implementation.changedFiles?.length ?? 0) === 0 &&
    !hasCodeArtifact(implementation.artifactHandles)
  ) {
    failures.push("changed files or code-change artifacts are required");
  }
  return failures;
}

function validateNoCodeChangeEvidence(implementation: DelegatedImplementationResult): string[] {
  const failures: string[] = [];
  if (blank(implementation.noCodeChangeRationale)) {
    failures.push("no-code-change rationale is required");
  }
  if (
    !hasEvidence(implementation.artifactHandles) &&
    !hasEvidence(implementation.denHandoffHandles)
  ) {
    failures.push("no-code-change evidence handles are required");
  }
  return failures;
}

function validateCheckEvidence(
  implementation: DelegatedImplementationResult,
  spawnRequest: DelegationSpawnRequest,
): string[] {
  const failures: string[] = [];
  if (spawnRequest.requiredEvidence?.requireTests === true && implementation.checks.length === 0) {
    failures.push("implementation checks/tests are required");
  }
  for (const check of implementation.checks) failures.push(...validateCheck(check));
  return failures;
}

function validateCheck(check: DelegatedImplementationCheck): string[] {
  const failures: string[] = [];
  if (blank(check.command)) failures.push("implementation check command is required");
  if (!validCheckStatus(check.status))
    failures.push(`implementation check ${check.command} status is invalid`);
  if (blank(check.summary))
    failures.push(`implementation check ${check.command} summary is required`);
  return failures;
}

function validateWorkdirEvidence(
  implementation: DelegatedImplementationResult,
  spawnRequest: DelegationSpawnRequest,
): string[] {
  const status = implementation.workdirStatus;
  if (spawnRequest.requiredEvidence?.requireWorkdirStatus === true && status === undefined) {
    return ["workdir status evidence is required"];
  }
  if (status === undefined) return [];
  const failures: string[] = [];
  if (!validWorkdirState(status.state)) failures.push("workdir state is invalid");
  if (blank(status.summary)) failures.push("workdir status summary is required");
  if (status.state === "dirty_unexpected") failures.push("workdir has unexpected dirty files");
  return failures;
}

function validateHandleEvidence(
  implementation: DelegatedImplementationResult,
  spawnRequest: DelegationSpawnRequest,
): string[] {
  const failures: string[] = [];
  if (spawnRequest.requiredEvidence?.requireEvidenceHandles === true) {
    if (
      !hasEvidence(implementation.artifactHandles) &&
      !hasEvidence(implementation.denHandoffHandles)
    ) {
      failures.push("implementation artifact or handoff handles are required");
    }
  }
  for (const handle of [
    ...implementation.artifactHandles,
    ...(implementation.denHandoffHandles ?? []),
  ]) {
    failures.push(...validateArtifact(handle));
  }
  return failures;
}

function validateArtifact(handle: DelegatedArtifactHandle): string[] {
  const failures: string[] = [];
  if (blank(handle.description)) failures.push("artifact description is required");
  if (!validArtifactType(handle.type)) failures.push("artifact type is invalid");
  return failures;
}

function hasEvidence(handles: readonly DelegatedArtifactHandle[] | undefined): boolean {
  return handles !== undefined && handles.length > 0;
}

function hasCodeArtifact(handles: readonly DelegatedArtifactHandle[]): boolean {
  return handles.some((handle) => handle.type === "code_change" || handle.type === "file");
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function validImplementationStatus(value: string): boolean {
  return (
    value === "implemented" ||
    value === "no_code_change" ||
    value === "blocked" ||
    value === "failed" ||
    value === "insufficient_evidence"
  );
}

function validCheckStatus(value: string): boolean {
  return value === "passed" || value === "failed" || value === "not_run";
}

function validWorkdirState(value: string): boolean {
  return value === "clean" || value === "dirty_expected" || value === "dirty_unexpected";
}

function validArtifactType(value: string): boolean {
  return (
    value === "den_document" ||
    value === "den_message" ||
    value === "code_change" ||
    value === "file" ||
    value === "inventory_note"
  );
}

function formatValidationFailures(failures: readonly string[]): string {
  return `Delegated implementation evidence validation failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`;
}
