/** Runtime tests for reviewer role assembly selection in WorkerRuntime. */

import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { WorkerRuntime, type WorkerExecutor } from "../../workers/worker-runtime.js";
import {
  FakeAuditRepo,
  FakeSessionManager,
  makeAcceptingPoster,
  makeBinding,
  makeFakePool,
  makeRoleMapping,
} from "./worker-runtime-test-fixtures.js";

describe("Reviewer role assembly runtime wiring", () => {
  it("exposes ReviewerRoleAssembly on the reviewer execution path", async () => {
    const executor: WorkerExecutor = {
      execute(context) {
        const assembly = context.getWorkerRoleAssembly();
        const input = context.buildWorkerRoleInput();

        expect(assembly?.role).toBe("reviewer");
        expect(input.profileId).toBe("spawned-reviewer");
        expect(assembly?.selectMcpToolSets(input)).toEqual([
          "filesystem_readonly",
          "git_diff_log",
          "den",
        ]);
        expect(assembly?.drainEssentialTools(input)).toEqual([
          "context_status",
          "post_structured_completion",
        ]);

        return Promise.resolve({
          status: "completed",
          artifacts: [{ type: "role_assembly", ref: "reviewer", summary: "reachable" }],
          filesTouched: [],
          toolsUsed: ["role-assembly-reviewer"],
          tokensConsumed: 0,
          summary: "reviewer role assembly reachable",
        });
      },
    };
    const runtime = new WorkerRuntime(
      { workerIdentity: "reviewer-worker" },
      makeRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      new FakeEventBus(),
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    const packet = await runtime.executeAssignment(
      makeBinding({ role: "reviewer" }),
      executor,
    );

    expect(packet.status).toBe("completed");
    expect(packet.toolsUsed).toEqual(["role-assembly-reviewer"]);
  });
});
