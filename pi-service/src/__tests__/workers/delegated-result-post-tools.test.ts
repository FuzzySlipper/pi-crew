/** Tests for delegated structured-result post tools. */

import { describe, expect, it } from "vitest";
import type { DelegatedImplementationResult } from "@pi-crew/core";
import { createDelegatedResultPostTools } from "../../workers/delegated-result-post-tools.js";

describe("createDelegatedResultPostTools", () => {
  it("captures a valid implementation result and terminates", async () => {
    let captured: DelegatedImplementationResult | undefined;
    const [tool] = createDelegatedResultPostTools({
      expectedResultSchema: "implementation",
      onImplementation: (result) => {
        captured = result;
      },
      onReview: () => {},
    });

    const result = await tool!.execute("call-1", {
      status: "no_code_change",
      taskId: "2403",
      noCodeChangeRationale: "diagnostic",
      artifactHandles: [{ type: "file", description: "package", filePath: "package.json" }],
      checks: [{ command: "npm run build", status: "passed", summary: "passed" }],
      workdirStatus: { state: "clean", summary: "clean" },
    });

    expect(result.terminate).toBe(true);
    expect(captured?.taskId).toBe("2403");
    expect(captured?.status).toBe("no_code_change");
  });
});
