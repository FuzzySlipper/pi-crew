/** Tests for ReviewerRoleAssembly — supervised Agent role configuration. */

import { describe, expect, it } from "vitest";
import { ReviewerRoleAssembly } from "../../workers/role-assembly-reviewer.js";
import type { WorkerBinding } from "../../sessions/types.js";
import type { WorkerRoleInput } from "../../workers/worker-role-assembly.js";

function makeBinding(overrides?: Partial<WorkerBinding>): WorkerBinding {
  return {
    assignmentId: "990",
    runId: "piw_reviewer_run",
    taskId: "2100",
    projectId: "pi-crew",
    role: "reviewer",
    ...overrides,
  };
}

function makeInput(overrides?: Partial<WorkerRoleInput>): WorkerRoleInput {
  return {
    binding: makeBinding(),
    sessionId: "session-reviewer-01",
    profileId: "spawned-reviewer",
    roleConfig: {
      systemPromptSource: "spawned-reviewer",
    },
    ...overrides,
  };
}

describe("ReviewerRoleAssembly", () => {
  it("identifies the reviewer role", () => {
    expect(ReviewerRoleAssembly.role).toBe("reviewer");
  });

  it("builds a system prompt from profile and Den assignment context", () => {
    const prompt = ReviewerRoleAssembly.buildSystemPrompt(makeInput());

    expect(prompt).toContain("Reviewer");
    expect(prompt).toContain("spawned-reviewer");
    expect(prompt).toContain("pi-crew");
    expect(prompt).toContain("2100");
    expect(prompt).toContain("piw_reviewer_run");
    expect(prompt).toContain("review_findings_packet");
    expect(prompt).toContain("reviewer_context_packet");
    expect(prompt).toContain("looks_good");
  });

  it("selects read-only filesystem git diff/log and Den MCP tool sets", () => {
    expect(ReviewerRoleAssembly.selectMcpToolSets(makeInput())).toEqual([
      "filesystem_readonly",
      "git_diff_log",
      "den",
    ]);
  });

  it("uses configured MCP tool sets when supplied by role config", () => {
    const sets = ReviewerRoleAssembly.selectMcpToolSets(
      makeInput({
        roleConfig: {
          mcpToolSet: ["den", "git_diff_log"],
        },
      }),
    );

    expect(sets).toEqual(["den", "git_diff_log"]);
  });

  it("keeps context status and structured completion as drain essentials", () => {
    expect(ReviewerRoleAssembly.drainEssentialTools(makeInput())).toEqual([
      "context_status",
      "post_structured_completion",
      "request_checkpoint",
    ]);
  });

  it("includes review packet context in the initial user message", () => {
    const messages = ReviewerRoleAssembly.buildInitialMessages(makeInput());

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message).toBeDefined();
    if (message === undefined) throw new Error("expected a message");
    expect(message.role).toBe("user");
    if (message.role !== "user") throw new Error("expected user message");
    expect(typeof message.content).toBe("string");
    if (typeof message.content !== "string") throw new Error("expected text content");
    expect(message.content).toContain("reviewer_context_packet");
    expect(message.content).toContain("review_findings_packet");
    expect(message.content).toContain("assignmentId: 990");
    expect(message.content).toContain("runId: piw_reviewer_run");
    expect(message.content).toContain("taskId: 2100");
    expect(message.content).toContain("projectId: pi-crew");
    expect(message.content).toContain("post_structured_completion");
  });
});
