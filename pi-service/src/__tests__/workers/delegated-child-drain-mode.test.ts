/** Tests for delegated child drain-mode prompting. */

import { describe, expect, it } from "vitest";
import { buildDrainModePrompt } from "../../workers/llm-delegated-child-runner.js";

describe("buildDrainModePrompt", () => {
  it("forces implementation children to finalize without more tools", () => {
    const prompt = buildDrainModePrompt({
      task: "implement #2403",
      expectedResultSchema: "implementation",
      requiredEvidence: { taskIds: ["2403"] },
    });

    expect(prompt).toContain("Do not call more tools");
    expect(prompt).toContain("<delegated_implementation_result>");
    expect(prompt).toContain("structured blocked or insufficient_evidence result");
  });
});
