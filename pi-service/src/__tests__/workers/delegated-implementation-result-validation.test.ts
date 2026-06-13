import { describe, expect, it } from "vitest";
import type { DelegatedResult, DelegationSpawnRequest } from "@pi-crew/core";
import { validateDelegatedImplementationResult } from "../../workers/delegated-implementation-result-validation.js";

const implementationSpawn: DelegationSpawnRequest = {
  task: "implement #2401",
  expectedResultSchema: "implementation",
  requiredEvidence: {
    taskIds: ["2401"],
    requireBranch: true,
    requireHeadCommit: true,
    requireTests: true,
    requireWorkdirStatus: true,
    requireEvidenceHandles: true,
  },
};

describe("delegated implementation result validation", () => {
  it("turns wrapper-only implementation success into insufficient evidence failure", () => {
    const result = validateDelegatedImplementationResult(
      childResult({ outcome: "success", summary: "implemented" }),
      implementationSpawn,
    );

    expect(result.outcome).toBe("failure");
    expect(result.failureCategory).toBe("insufficient_evidence");
    expect(result.evidenceChecked).toBe(false);
    expect(result.safeExcerpt).toContain("missing structured implementation result");
  });

  it("requires tests when the implementation evidence contract requires tests", () => {
    const result = validateDelegatedImplementationResult(
      childResult({
        outcome: "success",
        implementation: {
          status: "implemented",
          taskId: "2401",
          branch: "feature/delegated-coding",
          headCommit: "abc123",
          changedFiles: ["pi-core/src/delegation.ts"],
          artifactHandles: [codeArtifact()],
          checks: [],
          workdirStatus: { state: "clean", summary: "clean" },
        },
      }),
      implementationSpawn,
    );

    expect(result.outcome).toBe("failure");
    expect(result.safeExcerpt).toContain("implementation checks/tests are required");
  });

  it("requires explicit rationale and evidence for no-code-change implementation results", () => {
    const result = validateDelegatedImplementationResult(
      childResult({
        outcome: "success",
        implementation: {
          status: "no_code_change",
          taskId: "2401",
          artifactHandles: [],
          checks: [{ command: "git status --short", status: "passed", summary: "clean" }],
          workdirStatus: { state: "clean", summary: "clean" },
        },
      }),
      {
        ...implementationSpawn,
        requiredEvidence: { ...implementationSpawn.requiredEvidence, allowNoCodeChange: true },
      },
    );

    expect(result.outcome).toBe("failure");
    expect(result.safeExcerpt).toContain("no-code-change rationale is required");
    expect(result.safeExcerpt).toContain("no-code-change evidence handles are required");
  });

  it("accepts valid implementation evidence and preserves implementation details", () => {
    const result = validateDelegatedImplementationResult(
      childResult({
        outcome: "success",
        evidenceChecked: true,
        implementation: {
          status: "implemented",
          taskId: "2401",
          branch: "feature/delegated-coding",
          headCommit: "abc123",
          changedFiles: ["pi-core/src/delegation.ts"],
          artifactHandles: [codeArtifact()],
          checks: [{ command: "npm test -- delegated", status: "passed", summary: "tests passed" }],
          workdirStatus: { state: "clean", summary: "working tree clean" },
          denHandoffHandles: [{ type: "den_message", messageId: 14470, description: "handoff" }],
        },
      }),
      implementationSpawn,
    );

    expect(result.outcome).toBe("success");
    expect(result.implementation?.headCommit).toBe("abc123");
    expect(result.evidenceChecked).toBe(true);
  });

  it("keeps ordinary spawn_subagent behavior when implementation schema is absent", () => {
    const result = validateDelegatedImplementationResult(childResult({ outcome: "success" }), {
      task: "ordinary child",
    });

    expect(result.outcome).toBe("success");
    expect(result.failureCategory).toBeUndefined();
  });
});

function childResult(input: Partial<DelegatedResult>): DelegatedResult {
  return {
    outcome: "success",
    summary: "child summary",
    policyId: "delegated-child-session-1",
    childSessionId: "child-session-1",
    ...input,
  };
}

function codeArtifact(): {
  readonly type: "code_change";
  readonly commitSha: string;
  readonly description: string;
} {
  return { type: "code_change", commitSha: "abc123", description: "implementation commit" };
}
