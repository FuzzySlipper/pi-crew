/** Runtime tests for coder role assembly selection in WorkerRuntime. */

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

describe("Coder role assembly runtime wiring", () => {
  it("exposes CoderRoleAssembly on the coder execution path", async () => {
    const executor: WorkerExecutor = {
      execute(context) {
        const assembly = context.getWorkerRoleAssembly();
        const input = context.buildWorkerRoleInput();

        expect(assembly?.role).toBe("coder");
        expect(input.profileId).toBe("spawned-coder");
        expect(assembly?.selectMcpToolSets(input)).toEqual([
          "filesystem",
          "terminal",
          "git",
          "den",
        ]);
        expect(assembly?.drainEssentialTools(input)).toEqual([
          "context_status",
          "post_structured_completion",
          "request_checkpoint",
        ]);

        return Promise.resolve({
          status: "completed",
          artifacts: [{ type: "role_assembly", ref: "coder", summary: "reachable" }],
          filesTouched: [],
          toolsUsed: ["role-assembly-coder"],
          tokensConsumed: 0,
          summary: "coder role assembly reachable",
        });
      },
    };
    const runtime = new WorkerRuntime(
      { workerIdentity: "coder-worker" },
      makeRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      new FakeEventBus(),
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    const packet = await runtime.executeAssignment(
      makeBinding({ role: "coder" }),
      executor,
    );

    expect(packet.status).toBe("completed");
    expect(packet.toolsUsed).toEqual(["role-assembly-coder"]);
  });
});
