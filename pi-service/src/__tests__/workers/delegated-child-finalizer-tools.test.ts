/** Tests for delegated child finalization tool surfaces. */

import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { selectDrainModeTools, buildDrainModePrompt } from "../../workers/delegated-child-drain-mode.js";
import { createDelegatedResultPostTools } from "../../workers/delegated-result-post-tools.js";

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: `ran ${name}` }], details: {} }),
  };
}

describe("selectDrainModeTools", () => {
  it("keeps only the implementation finalizer during implementation drain mode", () => {
    const tools = [tool("terminal"), tool("post_delegated_implementation_result")];

    const selected = selectDrainModeTools(tools, "implementation");

    expect(selected.map((candidate) => candidate.name)).toEqual([
      "post_delegated_implementation_result",
    ]);
  });

  it("keeps only the review finalizer during review drain mode", () => {
    const tools = [tool("read_file"), tool("post_delegated_review_result")];

    const selected = selectDrainModeTools(tools, "review");

    expect(selected.map((candidate) => candidate.name)).toEqual(["post_delegated_review_result"]);
  });

  it("tells review children to use the remaining finalizer in drain mode", () => {
    const prompt = buildDrainModePrompt({ task: "review", expectedResultSchema: "review" });

    expect(prompt).toContain("only the structured-result finalizer tool remains available");
    expect(prompt).toContain("Call post_delegated_review_result exactly once");
    expect(prompt).not.toContain("tool surface has been removed");
  });

  it("exposes concrete review finalizer schema and accepts harmless numeric ids", async () => {
    let postedTaskId = "";
    const [reviewTool] = createDelegatedResultPostTools({
      expectedResultSchema: "review",
      onImplementation: () => {},
      onReview: (result) => { postedTaskId = result.taskDecisions[0]?.taskId ?? ""; },
    });

    expect(reviewTool?.parameters).toMatchObject({
      properties: { taskDecisions: { items: { required: ["taskId", "decision", "summary", "evidenceHandles"] } } },
    });
    const result = await reviewTool?.execute("call-1", {
      status: "accepted",
      evidenceHandles: [{ type: "den_message", messageId: "14659", description: "start message" }],
      taskDecisions: [{
        taskId: 2443,
        decision: "accepted",
        summary: "reviewed",
        evidenceHandles: [{ type: "den_message", messageId: "14659", description: "start" }],
      }],
    }, new AbortController().signal);

    expect(result?.details).toEqual({ ok: true });
    expect(postedTaskId).toBe("2443");
  });
});
