import { describe, expect, it } from "vitest";
import type { DelegatedResult, DelegationSpawnRequest } from "@pi-crew/core";
import {
  appendImplementationResultInstructions,
  attachExtractedImplementationResult,
  extractImplementationResult,
} from "../../workers/delegated-implementation-result-extraction.js";

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

describe("delegated implementation result extraction", () => {
  it("adds explicit tagged JSON instructions for implementation-mode tasks", () => {
    const prompt = appendImplementationResultInstructions("implement #2401", implementationSpawn);

    expect(prompt).toContain("<delegated_implementation_result>");
    expect(prompt).toContain("Required task ids: 2401");
    expect(prompt).toContain("headCommit");
    expect(prompt).toContain("workdirStatus");
  });

  it("extracts tagged structured implementation JSON from assistant text", () => {
    const implementation = extractImplementationResult(
      `Done.\n<delegated_implementation_result>${validImplementationJson()}</delegated_implementation_result>`,
    );

    expect(implementation?.status).toBe("implemented");
    expect(implementation?.taskId).toBe("2401");
    expect(implementation?.checks[0]?.status).toBe("passed");
  });

  it("attaches valid extracted implementation evidence to delegated result", () => {
    const result = attachExtractedImplementationResult(
      baseResult(),
      implementationSpawn,
      `<delegated_implementation_result>${validImplementationJson()}</delegated_implementation_result>`,
    );

    expect(result.implementation?.headCommit).toBe("abc123");
    expect(result.evidenceChecked).toBe(true);
    expect(result.artifacts?.map((artifact) => artifact.description)).toEqual([
      "implementation commit",
      "implementation packet",
    ]);
    expect(result.safeExcerpt).toContain('"taskId": "2401"');
  });

  it("leaves malformed implementation text as safe excerpt for validator failure", () => {
    const result = attachExtractedImplementationResult(
      baseResult(),
      implementationSpawn,
      "I implemented it and tests pass.",
    );

    expect(result.implementation).toBeUndefined();
    expect(result.evidenceChecked).toBe(false);
    expect(result.safeExcerpt).toBe("I implemented it and tests pass.");
  });
});

function baseResult(): DelegatedResult {
  return {
    outcome: "success",
    summary: "completed",
    policyId: "policy",
    childSessionId: "child",
    evidenceChecked: false,
  };
}

function validImplementationJson(): string {
  return JSON.stringify({
    status: "implemented",
    taskId: "2401",
    branch: "feature/delegated-coding",
    headCommit: "abc123",
    changedFiles: ["pi-core/src/delegation.ts"],
    artifactHandles: [
      { type: "code_change", commitSha: "abc123", description: "implementation commit" },
    ],
    checks: [{ command: "npm test -- delegated", status: "passed", summary: "tests passed" }],
    workdirStatus: { state: "clean", summary: "working tree clean" },
    denHandoffHandles: [
      { type: "den_message", messageId: 14470, description: "implementation packet" },
    ],
  });
}
