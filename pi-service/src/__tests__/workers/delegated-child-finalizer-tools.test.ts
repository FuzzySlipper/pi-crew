/** Tests for delegated child finalization tool surfaces. */

import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { selectDrainModeTools } from "../../workers/delegated-child-drain-mode.js";

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
});
