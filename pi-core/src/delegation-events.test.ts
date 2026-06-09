import { describe, expect, it } from "vitest";
import type { GatewayEvent } from "./events.js";
import { createChildDelegationLineage } from "./delegation.js";

const lineage = createChildDelegationLineage({
  childSessionId: "child-a",
  parentSessionId: "parent-a",
});

const effectiveRuntime = {
  profileId: "child-profile",
  provider: "local-openai-compatible",
  model: "Qwen3.6-35B-A3B-MTP-GGUF",
};

describe("delegation visibility events", () => {
  it("attributes spawn visibility to parent, root, child, policy, and runtime", () => {
    const ev: GatewayEvent = {
      event: "delegation.spawned",
      payload: {
        childSessionId: "child-a",
        correlation: { runId: "run-1", taskId: "2167" },
        effectiveRuntime,
        lineage,
        policyId: "policy-child-a",
        spawnRequestId: "spawn-1",
        task: "review a patch",
      },
    };

    expect(ev.payload.lineage.rootSessionId).toBe("parent-a");
    expect(ev.payload.childSessionId).toBe("child-a");
    expect(ev.payload.effectiveRuntime?.model).toContain("Qwen3.6");
  });

  it("attributes turn and tool visibility to one child in parallel", () => {
    const turn: GatewayEvent = {
      event: "delegation.turn_visible",
      payload: {
        childSessionId: "child-a",
        lineage,
        phase: "started",
        policyId: "policy-child-a",
        turnNumber: 2,
      },
    };
    const tool: GatewayEvent = {
      event: "delegation.tool_visible",
      payload: {
        childSessionId: "child-a",
        durationMs: 25,
        lineage,
        phase: "completed",
        policyId: "policy-child-a",
        toolCallId: "tool-call-1",
        toolName: "read_file",
      },
    };

    expect(turn.payload.childSessionId).toBe(tool.payload.childSessionId);
    expect(tool.payload.lineage.parentSessionId).toBe("parent-a");
  });

  it("carries terminal delegation outcomes", () => {
    const completed: GatewayEvent = {
      event: "delegation.completed",
      payload: {
        result: {
          childSessionId: "child-a",
          effectiveRuntime,
          outcome: "success",
          policyId: "policy-child-a",
          summary: "finished",
        },
        lineage,
      },
    };
    const timeout: GatewayEvent = {
      event: "delegation.timeout",
      payload: {
        childSessionId: "child-b",
        elapsedMs: 5_001,
        lineage: createChildDelegationLineage({
          childSessionId: "child-b",
          parentSessionId: "parent-a",
        }),
        policyId: "policy-child-b",
        timeoutMs: 5_000,
      },
    };
    const killed: GatewayEvent = {
      event: "delegation.killed",
      payload: {
        childSessionId: "child-b",
        initiatedBy: "timeout",
        lineage: timeout.payload.lineage,
        policyId: "policy-child-b",
        reason: "timed out",
      },
    };
    const orphan: GatewayEvent = {
      event: "delegation.orphan_detected",
      payload: {
        idleDurationMs: 10_000,
        lastKnownParentSessionId: "parent-a",
        lineage: timeout.payload.lineage,
        orphanSessionId: "child-b",
        policyId: "policy-child-b",
      },
    };

    expect(completed.payload.result.outcome).toBe("success");
    expect(timeout.payload.childSessionId).toBe("child-b");
    expect(killed.payload.initiatedBy).toBe("timeout");
    expect(orphan.payload.orphanSessionId).toBe("child-b");
  });
});
