import { describe, expect, it } from "vitest";
import type {
  DelegatedArtifactHandle,
  DelegatedFailureCategory,
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

describe("DelegatedArtifactHandle", () => {
  it("accepts a Den document slug handle", () => {
    const handle: DelegatedArtifactHandle = {
      slug: "pi-crew/child-findings",
      description: "Review findings document",
      type: "den_document",
    };
    expect(handle.slug).toBe("pi-crew/child-findings");
    expect(handle.type).toBe("den_document");
  });

  it("accepts a Den message ID handle", () => {
    const handle: DelegatedArtifactHandle = {
      messageId: 14280,
      description: "Detailed completion message",
      type: "den_message",
    };
    expect(handle.messageId).toBe(14280);
  });

  it("accepts a git commit SHA handle", () => {
    const handle: DelegatedArtifactHandle = {
      commitSha: "abc123def456",
      description: "Analysis results commit",
      type: "code_change",
    };
    expect(handle.commitSha).toBe("abc123def456");
    expect(handle.type).toBe("code_change");
  });

  it("accepts a file path handle", () => {
    const handle: DelegatedArtifactHandle = {
      filePath: "/tmp/child-output/report.json",
      description: "Generated report",
      type: "file",
    };
    expect(handle.filePath).toBe("/tmp/child-output/report.json");
  });

  it("accepts an inventory note handle", () => {
    const handle: DelegatedArtifactHandle = {
      description: "Observation: API rate limit noted",
      type: "inventory_note",
    };
    expect(handle.type).toBe("inventory_note");
  });

  it("rejects invalid type values at compile time", () => {
    // @ts-expect-error — invalid type should be rejected
    const bad: DelegatedArtifactHandle = { type: "invalid_type", description: "bad" };
    expect(bad).toBeDefined();
  });
});

describe("DelegatedFailureCategory", () => {
  it("accepts all defined failure categories", () => {
    const categories: DelegatedFailureCategory[] = [
      "execution_error",
      "missing_artifact",
      "policy_denied",
      "provider_error",
      "no_progress",
      "malformed_result",
      "budget_exceeded",
    ];
    expect(categories).toHaveLength(7);
  });
});

describe("expanded DelegatedResult", () => {
  const baseResult: DelegatedResult = {
    childSessionId: "child-1",
    durationMs: 1500,
    outcome: "success",
    policyId: "policy-1",
    summary: "Completed research task",
  };

  it("carries artifact handles for doc-only work without implementation packet metadata", () => {
    const docResult: DelegatedResult = {
      ...baseResult,
      summary: "Document analysis complete",
      artifacts: [
        {
          slug: "pi-crew/subagent-analysis-001",
          description: "Full analysis document",
          type: "den_document",
        },
      ],
    };

    expect(docResult.artifacts).toHaveLength(1);
    expect(docResult.artifacts![0].slug).toBe("pi-crew/subagent-analysis-001");
    // No implementation packet metadata needed — this is a doc-only result
    expect(docResult.outcome).toBe("success");
  });

  it("carries safeExcerpt for bounded parent context injection", () => {
    const result: DelegatedResult = {
      ...baseResult,
      safeExcerpt:
        "Analyzed 3 files: found 2 lint issues and 1 type error. " +
        "Recommend fixing type error first. Full findings in findings doc.",
    };
    expect(result.safeExcerpt).toBeDefined();
    expect(result.safeExcerpt!.length).toBeLessThan(2000);
  });

  it("uses failureCategory for typed error classification", () => {
    const missingArtifact: DelegatedResult = {
      ...baseResult,
      outcome: "failure",
      failureCategory: "missing_artifact",
      error: "Child completed but did not produce expected document",
      recoveryGuidance: "Re-run with explicit artifact output path",
    };

    expect(missingArtifact.failureCategory).toBe("missing_artifact");
    expect(missingArtifact.recoveryGuidance).toBeDefined();
    // This is NOT a malformed implementation packet — it's a delegation result
    expect(missingArtifact.outcome).toBe("failure");
  });

  it("distinguishes missing_artifact from execution_error", () => {
    const execError: DelegatedResult = {
      ...baseResult,
      outcome: "failure",
      failureCategory: "execution_error",
      error: "Cannot connect to provider",
      recoveryGuidance: "Check provider API key and network access",
    };
    const missingArtifact: DelegatedResult = {
      ...baseResult,
      outcome: "failure",
      failureCategory: "missing_artifact",
      error: "Expected file not found at output path",
      recoveryGuidance: "Verify child tool permissions",
    };

    expect(execError.failureCategory).not.toBe(missingArtifact.failureCategory);
    expect(execError.recoveryGuidance).toContain("provider");
    expect(missingArtifact.recoveryGuidance).toContain("permissions");
  });

  it("tracks tools used for diagnostics", () => {
    const result: DelegatedResult = {
      ...baseResult,
      toolsUsed: ["read_file", "search_files", "terminal", "web_search"],
    };

    expect(result.toolsUsed).toContain("read_file");
    expect(result.toolsUsed).toHaveLength(4);
  });

  it("indicates whether evidence was checked", () => {
    const verified: DelegatedResult = {
      ...baseResult,
      evidenceChecked: true,
      artifacts: [
        { commitSha: "abc123", description: "Fix commit", type: "code_change" },
      ],
    };

    expect(verified.evidenceChecked).toBe(true);
    expect(verified.artifacts![0].commitSha).toBe("abc123");
  });

  it("supports timed-out results with recovery guidance", () => {
    const timeout: DelegatedResult = {
      childSessionId: "child-slow",
      durationMs: 300_000,
      outcome: "timeout",
      failureCategory: "no_progress",
      policyId: "policy-1",
      recoveryGuidance: "Increase timeoutMs or split task into smaller steps",
      summary: "Child ran full budget without completing",
      tokensConsumed: 15000,
      turnsUsed: 5,
    };

    expect(timeout.outcome).toBe("timeout");
    expect(timeout.failureCategory).toBe("no_progress");
    expect(timeout.tokensConsumed).toBe(15000);
    expect(timeout.turnsUsed).toBe(5);
  });

  it("supports killed results with reason", () => {
    const killed: DelegatedResult = {
      childSessionId: "child-killed",
      durationMs: 1000,
      outcome: "killed",
      policyId: "policy-1",
      summary: "Cancelled by operator",
      error: "Operator requested cancellation",
    };

    expect(killed.outcome).toBe("killed");
    expect(killed.error).toBe("Operator requested cancellation");
  });

  it("supports orphaned results with recovery guidance", () => {
    const orphaned: DelegatedResult = {
      childSessionId: "child-orphan",
      durationMs: undefined,
      outcome: "orphaned",
      policyId: "policy-1",
      recoveryGuidance: "Parent session died unexpectedly; child was auto-terminated",
      summary: "Parent session expired",
    };

    expect(orphaned.outcome).toBe("orphaned");
    expect(orphaned.recoveryGuidance).toContain("Parent session died");
  });

  it("allows multiple artifact handles of mixed types", () => {
    const result: DelegatedResult = {
      ...baseResult,
      artifacts: [
        { slug: "doc-1", description: "Analysis", type: "den_document" },
        { messageId: 14280, description: "Status update", type: "den_message" },
        { commitSha: "def789", description: "Fix applied", type: "code_change" },
        { filePath: "/tmp/report.json", description: "JSON output", type: "file" },
        { description: "Noted upstream deprecation", type: "inventory_note" },
      ],
    };

    expect(result.artifacts).toHaveLength(5);
    expect(result.artifacts!.filter((a) => a.type === "den_document")).toHaveLength(1);
    expect(result.artifacts!.filter((a) => a.type === "inventory_note")).toHaveLength(1);
  });

  it("preserves backward compatibility with existing DelegatedResult consumers", () => {
    // Minimal existing shape — only the original required fields
    const minimalResult: DelegatedResult = {
      childSessionId: "child-1",
      outcome: "success",
      policyId: "policy-1",
      summary: "done",
    };

    // All new fields are optional, so existing code that constructs
    // DelegatedResult without artifacts/failureCategory/safeExcerpt
    // continues to compile and work.
    expect(minimalResult.artifacts).toBeUndefined();
    expect(minimalResult.failureCategory).toBeUndefined();
    expect(minimalResult.safeExcerpt).toBeUndefined();
    expect(minimalResult.evidenceChecked).toBeUndefined();
    expect(minimalResult.toolsUsed).toBeUndefined();
  });
});
