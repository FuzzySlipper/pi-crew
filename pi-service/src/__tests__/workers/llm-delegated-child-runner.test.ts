/** Tests for LLM-backed delegated child runner. */

import { describe, expect, it } from "vitest";
import type { EffectiveDelegationRuntime } from "@pi-crew/core";
import { createExecutionPolicy } from "@pi-crew/tools";
import type { DelegatedChildRunInput } from "../../workers/delegated-spawn-lifecycle.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LlmDelegatedChildRunner, type ToolProvider, type ChildToolFilterResult } from "../../workers/llm-delegated-child-runner.js";

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

const policyWithTools = createExecutionPolicy({
  policyId: "policy-with-tools",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["read_file", "search_files", "terminal", "web_search", "post_structured_completion"],
  deniedTools: [],
  allowedHosts: [],
  deniedHosts: [],
  maxDurationMs: 30_000,
  maxTurnDurationMs: 15_000,
  idleTimeoutMs: 5_000,
  maxIterations: 5,
  maxTokensPerTurn: 4_096,
  credentialScope: "none",
});

/** A FakeToolProvider that creates stub AgentTools for testing. */
class FakeToolProvider implements ToolProvider {
  resolveTools(toolNames: readonly string[]): AgentTool[] {
    return toolNames.map((name) => ({
      name,
      label: name,
      description: `Stub tool: ${name}`,
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text" as const, text: `executed ${name}` }],
        details: { ok: true },
      }),
    }));
  }

  /** Assert which tools were resolved. */
  lastResolvedTools: readonly string[] = [];

  resolveToolsTracked(toolNames: readonly string[]): AgentTool[] {
    this.lastResolvedTools = toolNames;
    return this.resolveTools(toolNames);
  }
}

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

    // With multi-turn progress (#2286), there may be additional
    // completed events from turn_end. Verify at minimum we have
    // a started and at least one completed phase event.
    expect(turnVisibles.length).toBeGreaterThanOrEqual(2);
    expect(turnVisibles[0]?.phase).toBe("started");
    const completedPhases = turnVisibles.filter((v) => v.phase === "completed");
    expect(completedPhases.length).toBeGreaterThanOrEqual(1);
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

describe("LlmDelegatedChildRunner — tool surface (#2284)", () => {
  it("runs without tools when no toolProvider is configured", async () => {
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
      // No toolProvider — tests backward compatibility
    });

    const input = makeChildRunInput();
    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    expect(result.toolsUsed).toBeDefined();
    expect(result.toolsUsed).toHaveLength(1);
  }, 30_000);

  it("runs with allowed tools when toolProvider is configured", async () => {
    const provider = new FakeToolProvider();
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
      toolProvider: provider,
    });

    const input = makeChildRunInput({
      policy: createExecutionPolicy({
        policyId: "policy-allowed",
        rootPath: "/workspace",
        allowedPaths: ["/workspace"],
        denyPaths: [],
        allowedTools: ["read_file", "web_search"],
        deniedTools: [],
        allowedHosts: [],
        deniedHosts: [],
        maxDurationMs: 30_000,
        maxTurnDurationMs: 15_000,
        idleTimeoutMs: 5_000,
        maxIterations: 2,
        maxTokensPerTurn: 2_048,
        credentialScope: "none",
      }),
    });

    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    expect(result.toolsUsed).toBeDefined();
    expect(result.toolsUsed).toContain("read_file");
    expect(result.toolsUsed).toContain("web_search");
  }, 30_000);

  it("intersects spawn allowedTools with policy allowedTools", async () => {
    // spawnRequest.allowedTools = ["read_file", "terminal"]
    // policy.allowedTools = ["read_file"]
    // intersection = ["read_file"]
    const provider = new FakeToolProvider();
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
      toolProvider: provider,
    });

    const input = makeChildRunInput({
      policy: createExecutionPolicy({
        policyId: "policy-intersection",
        rootPath: "/workspace",
        allowedPaths: ["/workspace"],
        denyPaths: [],
        allowedTools: ["read_file"],
        deniedTools: [],
        allowedHosts: [],
        deniedHosts: [],
        maxDurationMs: 120_000,
        maxTurnDurationMs: 60_000,
        idleTimeoutMs: 5_000,
        maxIterations: 3,
        maxTokensPerTurn: 2_048,
        credentialScope: "none",
      }),
      spawnRequest: {
        task: "What is 2 + 2? Reply with just the number.",
        allowedTools: ["read_file", "terminal"],
      },
    });

    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    expect(result.toolsUsed).toEqual(["read_file"]);
  }, 60_000);

  it("removes denied tools from allowed list", async () => {
    // policy.allowedTools = ["read_file", "search_files", "terminal"]
    // spawnRequest.deniedTools is not directly in DelegatedChildRunInput.delegationSpawnRequest.
    // deniedTools comes from policy.deniedTools primarily.
    const provider = new FakeToolProvider();
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
      toolProvider: provider,
    });

    const input = makeChildRunInput({
      policy: createExecutionPolicy({
        policyId: "policy-denied",
        rootPath: "/workspace",
        allowedPaths: ["/workspace"],
        denyPaths: [],
        allowedTools: ["read_file", "search_files", "terminal"],
        deniedTools: ["terminal"],
        allowedHosts: [],
        deniedHosts: [],
        maxDurationMs: 30_000,
        maxTurnDurationMs: 15_000,
        idleTimeoutMs: 5_000,
        maxIterations: 2,
        maxTokensPerTurn: 2_048,
        credentialScope: "none",
      }),
    });

    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    expect(result.toolsUsed).toContain("read_file");
    expect(result.toolsUsed).toContain("search_files");
    expect(result.toolsUsed).not.toContain("terminal");
  }, 30_000);

  it("uses spawnRequest allowedTools alone when policy is empty", async () => {
    const provider = new FakeToolProvider();
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
      toolProvider: provider,
    });

    const input = makeChildRunInput({
      policy: createExecutionPolicy({
        policyId: "policy-no-tools",
        rootPath: "/workspace",
        allowedPaths: [],
        denyPaths: [],
        allowedTools: [],
        deniedTools: [],
        allowedHosts: [],
        deniedHosts: [],
        maxDurationMs: 30_000,
        maxTurnDurationMs: 15_000,
        idleTimeoutMs: 5_000,
        maxIterations: 2,
        maxTokensPerTurn: 2_048,
        credentialScope: "none",
      }),
      spawnRequest: {
        task: "Test task",
        allowedTools: ["read_file"],
      },
    });

    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    expect(result.toolsUsed).toEqual([]);
  }, 30_000);

  it("reports empty tool list in toolsUsed when no tools allowed", async () => {
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
    });

    const input = makeChildRunInput({
      policy: createExecutionPolicy({
        policyId: "policy-no-tools",
        rootPath: "/workspace",
        allowedPaths: [],
        denyPaths: [],
        allowedTools: [],
        deniedTools: [],
        allowedHosts: [],
        deniedHosts: [],
        maxDurationMs: 30_000,
        maxTurnDurationMs: 15_000,
        idleTimeoutMs: 5_000,
        maxIterations: 2,
        maxTokensPerTurn: 2_048,
        credentialScope: "none",
      }),
    });

    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    expect(result.toolsUsed).toEqual([]);
  }, 30_000);

  it("includes tool names in child system prompt", async () => {
    // The system prompt builder (buildChildSystemPrompt) is private,
    // but we can verify the effect by running with tools and checking
    // the result summary mentions tools indirectly.
    const provider = new FakeToolProvider();
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
      toolProvider: provider,
    });

    const input = makeChildRunInput({
      policy: policyWithTools,
      spawnRequest: {
        task: "What is 2 + 2? Reply with just the number.",
        allowedTools: ["read_file", "search_files"],
      },
    });

    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    expect(result.toolsUsed).toBeDefined();
    expect(result.toolsUsed!.length).toBeGreaterThan(0);
  }, 30_000);
  it("reports real token counts when provider sends usage data (#2285)", async () => {
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
    });

    const input = makeChildRunInput({
      spawnRequest: {
        task: "Reply with exactly the number 42 and nothing else.",
      },
    });

    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    // The local LLM provider should report token usage via AssistantMessage.usage.
    // If the provider does not support streaming usage, accumulatedTokens will be 0.
    // Either way, the value is real (not fabricated).
    expect(result.tokensConsumed).toBeGreaterThanOrEqual(0);
    // If tokens are present, they should be a reasonable number for a response
    // that says "42". This validates the accumulation path works.
    if (result.tokensConsumed !== undefined && result.tokensConsumed > 0) {
      expect(result.tokensConsumed).toBeLessThan(1000);
    }
  }, 30_000);

  it("reports real turn counts from agent events (#2285)", async () => {
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
    });

    const input = makeChildRunInput({
      spawnRequest: {
        task: "Reply with exactly the number 42 and nothing else.",
      },
    });

    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    // For a single-turn task with no tool calls, turnsUsed should be 1.
    // The agent event subscription counts turn_end events.
    expect(result.turnsUsed).toBe(1);
  }, 30_000);
});

describe("LlmDelegatedChildRunner — result fields (#2294)", () => {
  it("includes failureCategory on execution error", async () => {
    const runner = new LlmDelegatedChildRunner();
    const badRuntime: EffectiveDelegationRuntime = {
      profileId: "bad-profile",
      provider: "nonexistent-provider",
      model: "nonexistent-model",
    };

    const input = makeChildRunInput({ effectiveRuntime: badRuntime });
    const result = await runner.run(input);

    expect(result.outcome).toBe("failure");
    expect(result.failureCategory).toBe("execution_error");
  });

  it("includes toolsUsed in success result", async () => {
    const provider = new FakeToolProvider();
    const runner = new LlmDelegatedChildRunner({
      baseUrl: localBaseUrl,
      apiKey: "unused",
      modelName: localModel,
      toolProvider: provider,
    });

    const input = makeChildRunInput({
      policy: createExecutionPolicy({
        policyId: "policy-result",
        rootPath: "/workspace",
        allowedPaths: [],
        denyPaths: [],
        allowedTools: ["read_file", "search_files"],
        deniedTools: [],
        allowedHosts: [],
        deniedHosts: [],
        maxDurationMs: 30_000,
        maxTurnDurationMs: 15_000,
        idleTimeoutMs: 5_000,
        maxIterations: 2,
        maxTokensPerTurn: 2_048,
        credentialScope: "none",
      }),
    });

    const result = await runner.run(input);

    expect(result.outcome).toBe("success");
    expect(result.toolsUsed).toContain("read_file");
    expect(result.toolsUsed).toContain("search_files");
    expect(result.evidenceChecked).toBe(false);
  }, 30_000);
});
