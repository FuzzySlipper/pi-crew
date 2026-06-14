/** Harness-owned tools for posting structured delegated child results. */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DelegatedImplementationResult, DelegatedReviewResult } from "@pi-crew/core";
import { extractImplementationResult } from "./delegated-implementation-result-extraction.js";
import { extractReviewResult } from "./delegated-review-result-extraction.js";

export interface DelegatedResultPostToolConfig {
  readonly expectedResultSchema?: "implementation" | "review";
  readonly onImplementation: (result: DelegatedImplementationResult) => void;
  readonly onReview: (result: DelegatedReviewResult) => void;
}

export function createDelegatedResultPostTools(config: DelegatedResultPostToolConfig): AgentTool[] {
  if (config.expectedResultSchema === "implementation") {
    return [createImplementationPostTool(config.onImplementation)];
  }
  if (config.expectedResultSchema === "review") {
    return [createReviewPostTool(config.onReview)];
  }
  return [];
}

function createImplementationPostTool(
  onImplementation: (result: DelegatedImplementationResult) => void,
): AgentTool {
  return {
    label: "Post delegated implementation result",
    name: "post_delegated_implementation_result",
    description:
      "Submit the final structured delegated implementation result. Use this instead of more tools once evidence is gathered.",
    parameters: implementationSchema(),
    execute: async (_toolCallId, params) => {
      const parsed = extractImplementationResult(JSON.stringify(params));
      if (parsed === null) {
        return {
          content: [{ type: "text", text: "Invalid delegated implementation result shape." }],
          details: { ok: false },
        };
      }
      onImplementation(parsed);
      return {
        content: [{ type: "text", text: "Delegated implementation result accepted." }],
        details: { ok: true },
        terminate: true,
      };
    },
  };
}

function createReviewPostTool(onReview: (result: DelegatedReviewResult) => void): AgentTool {
  return {
    label: "Post delegated review result",
    name: "post_delegated_review_result",
    description:
      "Submit the final structured delegated review result. Use this instead of more tools once evidence is gathered.",
    parameters: reviewSchema(),
    execute: async (_toolCallId, params) => {
      const parsed = extractReviewResult(JSON.stringify(params));
      if (parsed === null) {
        return {
          content: [{ type: "text", text: "Invalid delegated review result shape." }],
          details: { ok: false },
        };
      }
      onReview(parsed);
      return {
        content: [{ type: "text", text: "Delegated review result accepted." }],
        details: { ok: true },
        terminate: true,
      };
    },
  };
}

function implementationSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    required: ["status", "taskId", "artifactHandles", "checks"],
    properties: {
      status: {
        type: "string",
        enum: ["implemented", "no_code_change", "blocked", "failed", "insufficient_evidence"],
      },
      taskId: { type: "string" },
      branch: { type: "string" },
      headCommit: { type: "string" },
      noCodeChangeRationale: { type: "string" },
      changedFiles: { type: "array", items: { type: "string" } },
      artifactHandles: { type: "array", items: { type: "object", additionalProperties: true } },
      checks: { type: "array", items: { type: "object", additionalProperties: true } },
      workdirStatus: { type: "object", additionalProperties: true },
      denHandoffHandles: { type: "array", items: { type: "object", additionalProperties: true } },
    },
  };
}

function reviewSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    required: ["status", "evidenceHandles", "taskDecisions"],
    properties: {
      status: {
        type: "string",
        enum: ["accepted", "changes_requested", "blocked", "insufficient_evidence"],
      },
      evidenceHandles: { type: "array", items: reviewEvidenceHandleSchema() },
      taskDecisions: { type: "array", items: reviewTaskDecisionSchema() },
      findings: { type: "array", items: reviewFindingSchema() },
    },
  };
}

function reviewTaskDecisionSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    required: ["taskId", "decision", "summary", "evidenceHandles"],
    properties: {
      taskId: { oneOf: [{ type: "string" }, { type: "number" }] },
      decision: {
        type: "string",
        enum: ["accepted", "changes_requested", "blocked", "insufficient_evidence"],
      },
      summary: { type: "string" },
      evidenceHandles: { type: "array", items: reviewEvidenceHandleSchema() },
      findings: { type: "array", items: reviewFindingSchema() },
    },
  };
}

function reviewFindingSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    required: ["severity", "category", "summary"],
    properties: {
      taskId: { oneOf: [{ type: "string" }, { type: "number" }] },
      severity: { type: "string", enum: ["blocker", "major", "minor", "info"] },
      category: { type: "string" },
      summary: { type: "string" },
      location: { type: "string" },
    },
  };
}

function reviewEvidenceHandleSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    required: ["type", "description"],
    properties: {
      type: {
        type: "string",
        enum: ["den_message", "den_document", "code_change", "file", "inventory_note"],
      },
      description: { type: "string" },
      messageId: { oneOf: [{ type: "number" }, { type: "string" }] },
      slug: { type: "string" },
      filePath: { type: "string" },
      commitSha: { type: "string" },
    },
  };
}
