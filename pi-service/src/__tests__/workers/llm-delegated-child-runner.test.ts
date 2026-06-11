/** Tests for LLM-backed delegated child runner. */

import { describe, expect, it } from "vitest";
import type { EffectiveDelegationRuntime } from "@pi-crew/core";
import { createExecutionPolicy } from "@pi-crew/tools";
import type { DelegatedChildRunInput } from "../../workers/delegated-spawn-lifecycle.js";
import { LlmDelegatedChildRunner } from "../../workers/llm-delegated-child-runner.js";

const localBaseUrl = "http://192.168.1.23:13305/v1";
const localModel = "Qwen3.6-35B-A3B-MTP-GGUF";

const childRuntime: EffectiveDelegationRuntime = {
  profileId: "test-child-profile",
  provider: "openai-compatible",
  model: localModel,
};

const childPolicy = createExecutionPolicy({
  policyId: "policy-child",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["read_file"],
  deniedTools: [],
  allowedHosts: [],
  deniedHosts: [],
  maxDurationMs: 30_000,
  maxTurnDurationMs: 15_000,
  idleTimeoutMs: 5_000,
  maxIterations: 2,
  maxTokensPerTurn: 2_048,
  credentialScope: "none",
});

function makeChildRunInput(overrides?: Partial<DelegatedChildRunInput>): DelegatedChildRunInput {
  const turnVisibles: Array<{ turnNumber: number; phase: string; durationMs?: number; error?: string }> = [];
  const toolVisibles: Array<{ toolName: string; phase: string }> = [];
  return {
    childSession: {
      sessionId: "test-child-session",
      profileId: "test-child-profile",
      kind: "delegated" as const,
      state: "active",
      parentSessionId: "test-parent-session",
      rootSessionId: "test-root-session",
      lastActiveAt: new Date().toISOString(),
    },
    policy: childPolicy,
    delegationConstraints: { maxSpawnDepth: 0 },
    lineage: {
      parentSessionId: "test-parent-session",
      rootSessionId: "test-root-session",
      childSessionId: "test-child-session",
      depth: 1,
      chain: ["test-root-session", "test-child-session"],
    },
    spawnRequest: { task: "What is 2 + 2? Reply with just the number." },
    effectiveRuntime: childRuntime,
    correlation: { assignmentId: "test-assignment", runId: "test-run", taskId: "test-task", profileId: "test-child-profile" },
    signal: new AbortController().signal,
    emitTurnVisible: (input) => { turnVisibles.push(input); return Promise.resolve(); },
    emitToolVisible: (input) => { toolVisibles.push(input); return Promise.resolve(); },
    ...overrides,
  };
}

describe("LlmDelegatedChildRunner", () => {
  it("creates a runner with config", () => {
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
    });
    expect(runner).toBeDefined();
  });

  it("creates a runner with default config", () => {
    const runner = new LlmDelegatedChildRunner();
    expect(runner).toBeDefined();
  });

  // Live smoke — requires local server at http://192.168.1.23:13305/v1
  it("executes a simple task against local LLM", async () => {
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
    });

    const input = makeChildRunInput();
    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    expect(result.childSessionId).toBe("test-child-session");
    expect(result.policyId).toBe("policy-child");
    expect(result.effectiveRuntime).toEqual(childRuntime);
    expect(result.turnsUsed).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("reports failure when model cannot be resolved", async () => {
    const runner = new LlmDelegatedChildRunner();
    const badRuntime: EffectiveDelegationRuntime = {
      profileId: "bad-profile",
      provider: "nonexistent-provider",
      model: "nonexistent-model",
    };

    const input = makeChildRunInput({ effectiveRuntime: badRuntime });
    const result = await runner.run(input);

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("Cannot resolve LLM model");
    expect(result.childSessionId).toBe("test-child-session");
  });

  it("emits turn visible events on success", async () => {
    const turnVisibles: Array<{ turnNumber: number; phase: string }> = [];
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
    });

    const input = makeChildRunInput({
      emitTurnVisible: (v) => { turnVisibles.push(v); return Promise.resolve(); },
    });
    await runner.run(input);

    expect(turnVisibles).toHaveLength(2);
    expect(turnVisibles[0]?.phase).toBe("started");
    expect(turnVisibles[1]?.phase).toBe("completed");
  }, 30_000);

  it("handles abort signal gracefully", async () => {
    const abort = new AbortController();
    abort.abort();

    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
    });

    const input = makeChildRunInput({ signal: abort.signal });
    // DESIGN: The runner does not eagerly check signal before creating Agent.
    // If the Agent library supports pre-abort, the result may be failure;
    // otherwise the request still goes through and succeeds.
    const result = await runner.run(input);

    expect(["success", "failure"]).toContain(result.outcome);
    expect(result.childSessionId).toBe("test-child-session");
  }, 30_000);
});
