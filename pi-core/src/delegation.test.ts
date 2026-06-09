import { describe, expect, it } from "vitest";
import type {
  DelegatedResult,
  DelegationConstraints,
  DelegationLineage,
  DelegationModelSelection,
  DelegationSpawnRequest,
  EffectiveDelegationRuntime,
} from "./delegation.js";
import { createChildDelegationLineage } from "./delegation.js";

const rootLineage = createChildDelegationLineage({
  childSessionId: "child-1",
  parentSessionId: "root-session",
});

describe("delegation lineage foundation", () => {
  it("creates first-level child lineage from a top-level parent", () => {
    expect(rootLineage).toEqual({
      parentSessionId: "root-session",
      rootSessionId: "root-session",
      childSessionId: "child-1",
      depth: 1,
      chain: ["root-session", "child-1"],
    } satisfies DelegationLineage);
  });

  it("extends parent lineage without losing root identity", () => {
    const grandchild = createChildDelegationLineage({
      childSessionId: "child-2",
      parentLineage: rootLineage,
      parentSessionId: "child-1",
    });

    expect(grandchild.rootSessionId).toBe("root-session");
    expect(grandchild.parentSessionId).toBe("child-1");
    expect(grandchild.childSessionId).toBe("child-2");
    expect(grandchild.depth).toBe(2);
    expect(grandchild.chain).toEqual(["root-session", "child-1", "child-2"]);
  });

  it("does not alias lineage chains between levels", () => {
    const grandchild = createChildDelegationLineage({
      childSessionId: "child-2",
      parentLineage: rootLineage,
      parentSessionId: "child-1",
    });

    expect(rootLineage.chain).toEqual(["root-session", "child-1"]);
    expect(grandchild.chain).not.toBe(rootLineage.chain);
  });
});

describe("delegation request and result shapes", () => {
  it("expresses child model/profile selection independently from the parent", () => {
    const modelSelection: DelegationModelSelection = {
      profileId: "reviewer-child",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    };
    const request: DelegationSpawnRequest = {
      task: "review changed files",
      modelSelection,
      allowedTools: ["read_file", "terminal"],
      maxSpawnDepth: 0,
      timeoutMs: 120_000,
    };

    expect(request.modelSelection?.profileId).toBe("reviewer-child");
    expect(request.modelSelection?.model).toBe("anthropic/claude-sonnet-4");
  });

  it("carries effective runtime identity for audit visibility", () => {
    const runtime: EffectiveDelegationRuntime = {
      profileId: "reviewer-child",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    };
    const result: DelegatedResult = {
      childSessionId: "child-1",
      durationMs: 42,
      effectiveRuntime: runtime,
      outcome: "success",
      policyId: "policy-child-1",
      summary: "review complete",
    };

    expect(result.effectiveRuntime).toEqual(runtime);
  });

  it("captures spawn depth and parallel child constraints", () => {
    const constraints: DelegationConstraints = {
      maxConcurrentChildren: 3,
      maxSpawnDepth: 2,
    };

    expect(constraints.maxSpawnDepth).toBe(2);
    expect(constraints.maxConcurrentChildren).toBe(3);
  });
});
