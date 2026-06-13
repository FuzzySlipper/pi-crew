import { describe, expect, it } from "vitest";
import {
  ok,
  type DelegatedResult,
  type EffectiveDelegationRuntime,
  type Result,
} from "@pi-crew/core";
import { createExecutionPolicy } from "@pi-crew/tools";
import { createDelegatedSpawnTool } from "../../workers/delegated-spawn-tool.js";
import type {
  DelegatedSpawnError,
  DelegatedSpawnInput,
} from "../../workers/delegated-spawn-lifecycle.js";

const runtime: EffectiveDelegationRuntime = {
  profileId: "parent",
  provider: "local",
  model: "small",
};
const policy = createExecutionPolicy({
  policyId: "parent-policy",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["spawn_subagent"],
  deniedTools: [],
  allowedHosts: [],
  deniedHosts: [],
  maxDurationMs: 10_000,
  maxTurnDurationMs: 1_000,
  idleTimeoutMs: 1_000,
  maxIterations: 2,
  maxTokensPerTurn: 1_000,
  credentialScope: "read_only",
});

describe("createDelegatedSpawnTool review schema", () => {
  it("passes review result expectations into the lifecycle spawn request", async () => {
    const lifecycle = new CapturingLifecycle();
    const tool = createDelegatedSpawnTool({
      lifecycle,
      parentSessionId: "parent-session",
      parentPolicy: policy,
      parentDelegationConstraints: { maxSpawnDepth: 1 },
      parentRuntime: runtime,
    });

    const result = await tool.execute(
      "call-1",
      {
        task: "review #2344 and #2345",
        expectedResultSchema: "review",
        requiredEvidence: { taskIds: ["2344", "2345"], requireEvidenceHandles: true },
      },
      new AbortController().signal,
    );

    expect(lifecycle.inputs[0]?.spawnRequest).toMatchObject({
      task: "review #2344 and #2345",
      expectedResultSchema: "review",
      requiredEvidence: { taskIds: ["2344", "2345"], requireEvidenceHandles: true },
    });
    expect(result.details).toMatchObject({ ok: true });
    expect(tool.parameters).toMatchObject({
      required: ["task"],
      properties: { expectedResultSchema: { enum: ["review", "implementation"] } },
    });
  });

  it("passes implementation result expectations and exposes implementation result details", async () => {
    const lifecycle = new CapturingLifecycle();
    const tool = createDelegatedSpawnTool({
      lifecycle,
      parentSessionId: "parent-session",
      parentPolicy: policy,
      parentDelegationConstraints: { maxSpawnDepth: 1 },
      parentRuntime: runtime,
    });

    const result = await tool.execute(
      "call-1",
      {
        task: "implement #2401",
        expectedResultSchema: "implementation",
        requiredEvidence: {
          taskIds: ["2401"],
          requireBranch: true,
          requireHeadCommit: true,
          requireTests: true,
          requireWorkdirStatus: true,
        },
      },
      new AbortController().signal,
    );

    expect(lifecycle.inputs[0]?.spawnRequest).toMatchObject({
      task: "implement #2401",
      expectedResultSchema: "implementation",
      requiredEvidence: {
        taskIds: ["2401"],
        requireBranch: true,
        requireHeadCommit: true,
        requireTests: true,
        requireWorkdirStatus: true,
      },
    });
    expect(result.details).toMatchObject({
      ok: true,
      result: { implementation: { status: "implemented", headCommit: "abc123" } },
    });
  });
});

class CapturingLifecycle {
  readonly inputs: DelegatedSpawnInput[] = [];

  spawn(input: DelegatedSpawnInput): Promise<Result<DelegatedResult, DelegatedSpawnError>> {
    this.inputs.push(input);
    return Promise.resolve(
      ok({
        outcome: "success",
        summary: "child reviewed",
        policyId: "policy-child",
        childSessionId: "child-session",
        evidenceChecked: true,
        review: {
          status: "accepted",
          evidenceHandles: [{ type: "den_message", messageId: 14424, description: "packet" }],
          taskDecisions: [
            {
              taskId: "2344",
              decision: "accepted",
              summary: "reviewed",
              evidenceHandles: [{ type: "den_message", messageId: 14424, description: "packet" }],
            },
          ],
        },
        implementation: {
          status: "implemented",
          taskId: "2401",
          branch: "feature/delegated-coding",
          headCommit: "abc123",
          changedFiles: ["pi-core/src/delegation.ts"],
          artifactHandles: [
            { type: "code_change", commitSha: "abc123", description: "implementation commit" },
          ],
          checks: [{ command: "npm test -- delegated", status: "passed", summary: "passed" }],
          workdirStatus: { state: "clean", summary: "clean" },
        },
      }),
    );
  }
}
