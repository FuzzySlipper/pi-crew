/** Tests for pure delegated child ExecutionPolicy derivation. */

import { describe, expect, it } from "vitest";
import type { DelegationLineage, ExecutionPolicy, Result } from "@pi-crew/core";
import { createExecutionPolicy } from "../execution-policy.js";
import {
  deriveChildExecutionPolicy,
  type DelegationPolicyDerivation,
  type DelegationPolicyDerivationError,
} from "../delegation-policy.js";

function policy(overrides?: Partial<ExecutionPolicy>): ExecutionPolicy {
  return {
    ...createExecutionPolicy({
      policyId: "parent-policy",
      rootPath: "/workspace/task",
      allowedPaths: ["/workspace/task/src", "/workspace/task/docs"],
      denyPaths: ["/workspace/task/src/secrets"],
      allowedTools: ["read_file", "write_file", "terminal", "web_extract"],
      deniedTools: ["dangerous_tool"],
      allowedHosts: ["api.example.com", "den-srv"],
      deniedHosts: ["metadata.google.internal"],
      maxDurationMs: 600_000,
      maxTurnDurationMs: 120_000,
      idleTimeoutMs: 300_000,
      maxIterations: 20,
      maxTokensPerTurn: 64_000,
      credentialScope: "bounded_write",
    }),
    ...overrides,
  };
}

function lineage(childSessionId = "child-1"): DelegationLineage {
  return {
    parentSessionId: "parent-session",
    rootSessionId: "root-session",
    childSessionId,
    depth: 1,
    chain: ["root-session", childSessionId],
  };
}

function unwrapOk(
  result: Result<DelegationPolicyDerivation, DelegationPolicyDerivationError>,
): DelegationPolicyDerivation {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function unwrapError(
  result: Result<DelegationPolicyDerivation, DelegationPolicyDerivationError>,
): DelegationPolicyDerivationError {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected derivation failure");
  }
  return result.error;
}

describe("deriveChildExecutionPolicy", () => {
  it("derives child allowlists as parent subsets and denylists as supersets", () => {
    const derived = unwrapOk(deriveChildExecutionPolicy({
      parentPolicy: policy(),
      lineage: lineage(),
      parentDelegationConstraints: { maxSpawnDepth: 3, maxConcurrentChildren: 4 },
      requestedPolicy: {
        allowedTools: ["read_file", "web_extract"],
        deniedTools: ["terminal"],
        allowedPaths: ["/workspace/task/src"],
        denyPaths: ["/workspace/task/src/generated"],
        allowedHosts: ["api.example.com"],
        deniedHosts: ["den-srv"],
        credentialScope: "read_only",
        maxDurationMs: 300_000,
        maxTurnDurationMs: 60_000,
        idleTimeoutMs: 120_000,
        maxIterations: 8,
        maxTokensPerTurn: 16_000,
        maxSpawnDepth: 1,
        maxConcurrentChildren: 2,
      },
    }));

    expect(derived.policy.policyId).toBe("delegated-child-1");
    expect(derived.policy.allowedTools).toEqual(["read_file", "web_extract"]);
    expect(derived.policy.deniedTools).toEqual(["dangerous_tool", "terminal"]);
    expect(derived.policy.allowedPaths).toEqual(["/workspace/task/src"]);
    expect(derived.policy.denyPaths).toEqual([
      "/workspace/task/src/secrets",
      "/workspace/task/src/generated",
    ]);
    expect(derived.policy.allowedHosts).toEqual(["api.example.com"]);
    expect(derived.policy.deniedHosts).toEqual(["metadata.google.internal", "den-srv"]);
    expect(derived.policy.credentialScope).toBe("read_only");
    expect(derived.policy.maxDurationMs).toBe(300_000);
    expect(derived.policy.maxTurnDurationMs).toBe(60_000);
    expect(derived.policy.idleTimeoutMs).toBe(120_000);
    expect(derived.policy.maxIterations).toBe(8);
    expect(derived.policy.maxTokensPerTurn).toBe(16_000);
    expect(derived.delegationConstraints).toEqual({
      maxSpawnDepth: 1,
      maxConcurrentChildren: 2,
    });
    expect(derived.lineage).toEqual(lineage());
  });

  it("fails closed when requested allowlists or deny removals would expand parent authority", () => {
    const cases: readonly [string, NonNullable<Parameters<typeof deriveChildExecutionPolicy>[0]["requestedPolicy"]>][] = [
      ["allowed_tool_not_in_parent", { allowedTools: ["read_file", "write_file"] }],
      ["allowed_path_not_in_parent", { allowedPaths: ["/workspace/task/private"] }],
      ["allowed_host_not_in_parent", { allowedHosts: ["example.com"] }],
      ["credential_scope_escalation", { credentialScope: "full" }],
      ["duration_budget_escalation", { maxDurationMs: 600_001 }],
      ["turn_budget_escalation", { maxTurnDurationMs: 120_001 }],
      ["idle_budget_escalation", { idleTimeoutMs: 300_001 }],
      ["iteration_budget_escalation", { maxIterations: 21 }],
      ["token_budget_escalation", { maxTokensPerTurn: 64_001 }],
      ["spawn_depth_escalation", { maxSpawnDepth: 3 }],
      ["concurrent_children_escalation", { maxConcurrentChildren: 5 }],
    ];

    for (const [code, requestedPolicy] of cases) {
      const error = unwrapError(deriveChildExecutionPolicy({
        parentPolicy: policy({ allowedTools: ["read_file"] }),
        lineage: lineage(`child-${code}`),
        parentDelegationConstraints: { maxSpawnDepth: 3, maxConcurrentChildren: 4 },
        requestedPolicy,
      }));

      expect(error.code).toBe(code);
    }
  });

  it("maps spawn requests to explicit child tool, timeout, and depth constraints", () => {
    const derived = unwrapOk(deriveChildExecutionPolicy({
      parentPolicy: policy(),
      lineage: lineage("child-spawn"),
      parentDelegationConstraints: { maxSpawnDepth: 2, maxConcurrentChildren: 3 },
      spawnRequest: {
        task: "inspect docs",
        allowedTools: ["read_file"],
        deniedTools: ["terminal"],
        timeoutMs: 90_000,
        maxSpawnDepth: 0,
      },
    }));

    expect(derived.policy.allowedTools).toEqual(["read_file"]);
    expect(derived.policy.deniedTools).toEqual(["dangerous_tool", "terminal"]);
    expect(derived.policy.maxDurationMs).toBe(90_000);
    expect(derived.delegationConstraints.maxSpawnDepth).toBe(0);
  });

  it("defaults child spawn depth from explicit parent constraints without budget heuristics", () => {
    const derived = unwrapOk(deriveChildExecutionPolicy({
      parentPolicy: policy({ maxIterations: 1, maxTokensPerTurn: 1 }),
      lineage: lineage("child-depth"),
      parentDelegationConstraints: { maxSpawnDepth: 4, maxConcurrentChildren: 7 },
    }));

    expect(derived.delegationConstraints).toEqual({
      maxSpawnDepth: 3,
      maxConcurrentChildren: 7,
    });
  });

  it("returns independent child policy values for concurrent children", () => {
    const first = unwrapOk(deriveChildExecutionPolicy({
      parentPolicy: policy(),
      lineage: lineage("child-a"),
      parentDelegationConstraints: { maxSpawnDepth: 2 },
      requestedPolicy: { allowedTools: ["read_file"], deniedHosts: ["den-srv"] },
    }));
    const second = unwrapOk(deriveChildExecutionPolicy({
      parentPolicy: policy(),
      lineage: lineage("child-b"),
      parentDelegationConstraints: { maxSpawnDepth: 2 },
      requestedPolicy: { allowedTools: ["write_file"], deniedHosts: ["api.example.com"] },
    }));

    first.policy.allowedTools.push("terminal");
    first.policy.deniedHosts.push("api.example.com");

    expect(second.policy.allowedTools).toEqual(["write_file"]);
    expect(second.policy.deniedHosts).toEqual(["metadata.google.internal", "api.example.com"]);
    expect(policy().allowedTools).toEqual(["read_file", "write_file", "terminal", "web_extract"]);
  });
});
