import { describe, expect, it } from "vitest";
import {
  appendReviewResultInstructions,
  attachExtractedReviewResult,
  extractReviewResult,
  latestAssistantText,
} from "../../workers/delegated-review-result-extraction.js";
import type { DelegatedResult, DelegationSpawnRequest } from "@pi-crew/core";

const reviewSpawn: DelegationSpawnRequest = {
  task: "review tasks",
  expectedResultSchema: "review",
  requiredEvidence: { taskIds: ["2344", "2345"], requireEvidenceHandles: true },
};

describe("delegated review result extraction", () => {
  it("adds explicit tagged JSON instructions for review-mode tasks", () => {
    const prompt = appendReviewResultInstructions("review tasks", reviewSpawn);

    expect(prompt).toContain("<delegated_review_result>");
    expect(prompt).toContain("Required task decisions: 2344, 2345");
    expect(prompt).toContain("taskDecisions");
  });

  it("extracts tagged structured review JSON from assistant text", () => {
    const review = extractReviewResult(
      `Reviewed.\n<delegated_review_result>${validReviewJson()}</delegated_review_result>`,
    );

    expect(review?.status).toBe("accepted");
    expect(review?.taskDecisions.map((decision) => decision.taskId)).toEqual(["2344", "2345"]);
  });

  it("attaches valid extracted review to the delegated result", () => {
    const result = attachExtractedReviewResult(
      baseResult(),
      reviewSpawn,
      `<delegated_review_result>${validReviewJson()}</delegated_review_result>`,
    );

    expect(result.review?.status).toBe("accepted");
    expect(result.evidenceChecked).toBe(true);
    expect(result.artifacts?.map((artifact) => artifact.messageId)).toEqual([14424, 14425]);
    expect(result.safeExcerpt).toContain('"taskId": "2344"');
  });

  it("leaves malformed review text as safe excerpt for validator failure", () => {
    const result = attachExtractedReviewResult(
      baseResult(),
      reviewSpawn,
      "I reviewed it and it looks good.",
    );

    expect(result.review).toBeUndefined();
    expect(result.evidenceChecked).toBe(false);
    expect(result.safeExcerpt).toBe("I reviewed it and it looks good.");
  });

  it("reads the latest non-empty assistant text from agent state", () => {
    const text = latestAssistantText([
      { role: "assistant", content: "old" },
      { role: "toolResult", content: "tool" },
      { role: "assistant", content: "latest" },
    ]);

    expect(text).toBe("latest");
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

function validReviewJson(): string {
  return JSON.stringify({
    status: "accepted",
    evidenceHandles: [
      { type: "den_message", messageId: 14424, description: "implementation packet 2344" },
      { type: "den_message", messageId: 14425, description: "implementation packet 2345" },
    ],
    taskDecisions: [
      {
        taskId: "2344",
        decision: "accepted",
        summary: "Admin no-auth mode has implementation and smoke evidence.",
        evidenceHandles: [
          { type: "den_message", messageId: 14424, description: "implementation packet 2344" },
        ],
      },
      {
        taskId: "2345",
        decision: "accepted",
        summary: "Projection log behavior has implementation and smoke evidence.",
        evidenceHandles: [
          { type: "den_message", messageId: 14425, description: "implementation packet 2345" },
        ],
      },
    ],
    findings: [],
  });
}
