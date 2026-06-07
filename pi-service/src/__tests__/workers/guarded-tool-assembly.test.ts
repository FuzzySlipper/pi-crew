/**
 * Tests for guarded-tool-assembly — guarded Agent tool assembly and
 * Agent hook wiring for supervised WorkerRuntime.
 *
 * Proves:
 * - beforeToolCall denial prevents underlying tool execution.
 * - beforeToolCall emits structured denial evidence with Den correlation IDs.
 * - afterToolCall redacts credential-like content.
 * - Wrapper-level execute denial blocks post-dispatch when policy requires.
 * - assembleGuardedTools wraps all tools with policy enforcement.
 * - Denied tool result is model-visible as an error result.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { GatewayEvent, WorkerPolicy } from "@pi-crew/core";
import type { WorkerBinding } from "../../sessions/types.js";
import {
  createBeforeToolCallHook,
  createAfterToolCallHook,
  assembleGuardedTools,
  type GuardedToolAssemblyConfig,
  type ToolExecutor,
} from "../../workers/guarded-tool-assembly.js";
import type { AgentTool as PiAgentTool } from "../../workers/guarded-tool-types.js";
import type { AgentToolResult } from "../../workers/guarded-tool-types.js";

// ── Test helpers ─────────────────────────────────────────────────

function makeBinding(overrides?: Partial<WorkerBinding>): WorkerBinding {
  return {
    assignmentId: "711",
    runId: "piw_20260607074741_506821bc",
    taskId: "2069",
    projectId: "pi-crew",
    role: "coder",
    ...overrides,
  };
}

function makePolicy(overrides?: Partial<WorkerPolicy>): WorkerPolicy {
  return {
    assignmentId: "711",
    role: "coder",
    workdir: "/tmp/pi-worker",
    allowedPaths: [],
    denyPaths: [],
    allowedTools: [],
    deniedTools: [],
    allowedHosts: [],
    deniedHosts: [],
    maxDurationMs: 30 * 60 * 1000,
    maxTurnDurationMs: 5 * 60 * 1000,
    idleTimeoutMs: 10 * 60 * 1000,
    maxIterations: 50,
    maxTokensPerTurn: 128_000,
    credentialScope: "none",
    releaseOnCompletion: true,
    cleanupWorkdir: true,
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<GuardedToolAssemblyConfig>,
): GuardedToolAssemblyConfig {
  return {
    binding: overrides?.binding ?? makeBinding(),
    sessionId: "session-1",
    profileId: "spawned-coder",
    policy: overrides?.policy ?? makePolicy(),
    eventBus: new FakeEventBus(),
    logger: new FakeLogger(),
    ...overrides,
  };
}

/**
 * Minimal pi-agent-core AgentTool-like shape that our guarded assembly
 * produces. This mirrors the pi-agent-core AgentTool contract:
 * name, description, label, parameters/inputSchema, execute().
 */
function makePiAgentTool(
  overrides?: Partial<PiAgentTool>,
): PiAgentTool {
  return {
    name: "test_tool",
    label: "Test Tool",
    description: "A test tool",
    parameters: { type: "object", properties: {} } as unknown as PiAgentTool["parameters"],
    execute: vi.fn<() => Promise<AgentToolResult<unknown>>>().mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      details: undefined,
    }),
    ...overrides,
  };
}

/**
 * Minimal ToolExecutor fake that records tool calls.
 */
class FakeToolExecutor implements ToolExecutor {
  readonly calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  readonly #results = new Map<string, unknown>();

  setResult(name: string, result: unknown): void {
    this.#results.set(name, result);
  }

  callTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: unknown[]; error?: string }> {
    this.calls.push({ name, params });
    const result = this.#results.get(name);
    if (result instanceof Error) {
      return Promise.resolve({ ok: false, content: [], error: result.message });
    }
    return Promise.resolve({
      ok: true,
      content: result !== undefined
        ? [{ type: "text", text: String(result) }]
        : [{ type: "text", text: `result from ${name}` }],
    });
  }
}

// ── Fake BeforeToolCallContext / AfterToolCallContext ────────────

function makeBeforeCtx(overrides?: {
  toolName?: string;
  args?: unknown;
}): Parameters<ReturnType<typeof createBeforeToolCallHook>>[0] {
  return {
    assistantMessage: {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-1", name: overrides?.toolName ?? "test_tool", input: {} }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "tool_use",
      timestamp: Date.now(),
    },
    toolCall: {
      type: "toolCall",
      id: "tc-1",
      name: overrides?.toolName ?? "test_tool",
      input: overrides?.args ?? {},
    },
    args: overrides?.args ?? {},
    context: {
      systemPrompt: "test",
      messages: [],
    },
  };
}

function makeAfterCtx(overrides?: {
  toolName?: string;
  resultContent?: string;
  isError?: boolean;
}): Parameters<ReturnType<typeof createAfterToolCallHook>>[0] {
  return {
    assistantMessage: {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-1", name: overrides?.toolName ?? "test_tool", input: {} }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "tool_use",
      timestamp: Date.now(),
    },
    toolCall: {
      type: "toolCall",
      id: "tc-1",
      name: overrides?.toolName ?? "test_tool",
      input: {},
    },
    args: {},
    result: {
      content: [{ type: "text", text: overrides?.resultContent ?? "plain result" }],
      details: undefined,
    },
    isError: overrides?.isError ?? false,
    context: {
      systemPrompt: "test",
      messages: [],
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// beforeToolCall denial
// ══════════════════════════════════════════════════════════════════

describe("createBeforeToolCallHook", () => {
  it("denies a tool on the denylist", async () => {
    const policy = makePolicy({ deniedTools: ["bash"] });
    const config = makeConfig({ policy });
    const hook = createBeforeToolCallHook(config);
    const ctx = makeBeforeCtx({ toolName: "bash", args: {} });

    const result = await hook(ctx);

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("bash");
    expect(result?.reason).toContain("denied");
  });

  it("allows a tool not on the denylist", async () => {
    const policy = makePolicy({ deniedTools: ["bash"] });
    const config = makeConfig({ policy });
    const hook = createBeforeToolCallHook(config);
    const ctx = makeBeforeCtx({ toolName: "read_file", args: {} });

    const result = await hook(ctx);

    expect(result).toBeUndefined();
  });

  it("denies a tool not in the allowlist when allowlist is non-empty", async () => {
    const policy = makePolicy({ allowedTools: ["read_file", "write_file"] });
    const config = makeConfig({ policy });
    const hook = createBeforeToolCallHook(config);
    const ctx = makeBeforeCtx({ toolName: "bash", args: {} });

    const result = await hook(ctx);

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("allowlist");
  });

  it("allows a tool in the allowlist", async () => {
    const policy = makePolicy({ allowedTools: ["read_file", "write_file"] });
    const config = makeConfig({ policy });
    const hook = createBeforeToolCallHook(config);
    const ctx = makeBeforeCtx({ toolName: "read_file", args: {} });

    const result = await hook(ctx);

    expect(result).toBeUndefined();
  });

  it("emits tool.denied event with Den correlation IDs on denial", async () => {
    const eventBus = new FakeEventBus();
    const policy = makePolicy({ deniedTools: ["dangerous_tool"] });
    const config = makeConfig({ policy, eventBus });
    const hook = createBeforeToolCallHook(config);
    const ctx = makeBeforeCtx({ toolName: "dangerous_tool", args: {} });

    await hook(ctx);

    const deniedEvents = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "tool.denied",
    );
    expect(deniedEvents.length).toBe(1);
    const payload = deniedEvents[0]?.payload as { toolName: string; sessionId: string; reason: string; assignmentId?: string; runId?: string; taskId?: string };
    expect(payload.toolName).toBe("dangerous_tool");
    expect(payload.sessionId).toBe("session-1");
    expect(payload.reason).toContain("dangerous_tool");
    expect(payload.assignmentId).toBe("711");
    expect(payload.runId).toBe("piw_20260607074741_506821bc");
    expect(payload.taskId).toBe("2069");
  });

  it("emits policy.enforced event with correlation IDs on denial", async () => {
    const eventBus = new FakeEventBus();
    const policy = makePolicy({ deniedTools: ["blocked"] });
    const config = makeConfig({ policy, eventBus });
    const hook = createBeforeToolCallHook(config);
    const ctx = makeBeforeCtx({ toolName: "blocked", args: {} });

    await hook(ctx);

    const enforcedEvents = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "policy.enforced",
    );
    expect(enforcedEvents.length).toBeGreaterThanOrEqual(1);
    const payload = enforcedEvents[0]?.payload as { sessionId: string; checkKind: string; allowed: boolean; assignmentId?: string; runId?: string; taskId?: string };
    expect(payload.sessionId).toBe("session-1");
    expect(payload.checkKind).toBe("tool");
    expect(payload.allowed).toBe(false);
    expect(payload.assignmentId).toBe("711");
    expect(payload.runId).toBe("piw_20260607074741_506821bc");
    expect(payload.taskId).toBe("2069");
  });

  it("does not emit denial events when tool is allowed", async () => {
    const eventBus = new FakeEventBus();
    const config = makeConfig({ eventBus });
    const hook = createBeforeToolCallHook(config);
    const ctx = makeBeforeCtx({ toolName: "safe_tool", args: {} });

    await hook(ctx);

    const deniedEvents = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "tool.denied",
    );
    expect(deniedEvents.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// afterToolCall redaction
// ══════════════════════════════════════════════════════════════════

describe("createAfterToolCallHook", () => {
  it("redacts credential-like strings from tool result content", async () => {
    const config = makeConfig();
    const hook = createAfterToolCallHook(config);
    const ctx = makeAfterCtx({
      resultContent: "config loaded. api_key: sk-abc123def456789012345678 for provider openai",
    });

    const result = await hook(ctx);

    expect(result).toBeDefined();
    const content = result?.content;
    expect(content).toBeDefined();
    if (content && content.length > 0) {
      const textContent = content[0] as { type: string; text: string };
      expect(textContent.text).not.toContain("sk-abc123def456789012345678");
      expect(textContent.text).toContain("[REDACTED]");
    }
  });

  it("passes through clean results unchanged", async () => {
    const config = makeConfig();
    const hook = createAfterToolCallHook(config);
    const ctx = makeAfterCtx({ resultContent: "all clear, nothing sensitive" });

    const result = await hook(ctx);

    // No redaction needed — returns undefined to keep original
    expect(result).toBeUndefined();
  });

  it("handles empty result content", async () => {
    const config = makeConfig();
    const hook = createAfterToolCallHook(config);
    const ctx = makeAfterCtx({ resultContent: "" });

    const result = await hook(ctx);

    expect(result).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// assembleGuardedTools — wraps tools with policy enforcement
// ══════════════════════════════════════════════════════════════════

describe("assembleGuardedTools", () => {
  it("produces the same number of tools as input", () => {
    const config = makeConfig();
    const executor = new FakeToolExecutor();
    const tools = [
      makePiAgentTool({ name: "tool_a", label: "A" }),
      makePiAgentTool({ name: "tool_b", label: "B" }),
    ];

    const guarded = assembleGuardedTools(config, executor, tools);

    expect(guarded.length).toBe(2);
  });

  it("wraps tool execute so denied tools never call the executor", async () => {
    const eventBus = new FakeEventBus();
    const policy = makePolicy({ deniedTools: ["blocked_tool"] });
    const config = makeConfig({ policy, eventBus });
    const executor = new FakeToolExecutor();
    const tool = makePiAgentTool({ name: "blocked_tool", label: "Blocked" });

    const [guarded] = assembleGuardedTools(config, executor, [tool]);
    expect(guarded).toBeDefined();

    // Execute the guarded tool — should be denied by the wrapper
    // Note: the Agent's beforeToolCall handles pre-flight blocking,
    // AND our wrapper execute() adds second-line defense.
    // We test that the wrapper-level execute also blocks.

    // For this test, we exercise the wrapper execute directly with
    // a blocked tool name. The wrapped execute should refuse.
    if (guarded) {
      const result = await guarded.execute("tc-blocked", {}, undefined);
      // Result should be an error visible to the model
      const hasErrorText =
        Array.isArray(result.content) &&
        result.content.length > 0 &&
        typeof (result.content[0] as { text?: string })?.text === "string" &&
        (result.content[0] as { text: string }).text.toLowerCase().includes("denied");
      expect(hasErrorText).toBe(true);
    }

    // The executor should NOT have been called
    expect(executor.calls.length).toBe(0);

    // Policy denial evidence should be emitted
    const deniedEvents = eventBus.emitted.filter(
      (e: GatewayEvent) => e.event === "tool.denied",
    );
    expect(deniedEvents.length).toBe(1);
  });

  it("allows unblocked tools to execute through the executor", async () => {
    const config = makeConfig();
    const executor = new FakeToolExecutor();
    executor.setResult("safe_tool", "safe result");
    const tool = makePiAgentTool({ name: "safe_tool", label: "Safe" });

    const [guarded] = assembleGuardedTools(config, executor, [tool]);
    expect(guarded).toBeDefined();

    if (guarded) {
      const result = await guarded.execute("tc-safe", {}, undefined);
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
    }

    // The executor should have been called
    expect(executor.calls.length).toBe(1);
    expect(executor.calls[0]?.name).toBe("safe_tool");
  });

  it("preserves tool metadata (name, description, label) after wrapping", () => {
    const config = makeConfig();
    const executor = new FakeToolExecutor();
    const tool = makePiAgentTool({
      name: "meta_tool",
      label: "Meta Tool Label",
      description: "Meta tool description",
    });

    const [guarded] = assembleGuardedTools(config, executor, [tool]);
    expect(guarded).toBeDefined();
    if (guarded) {
      expect(guarded.name).toBe("meta_tool");
      expect(guarded.label).toBe("Meta Tool Label");
      expect(guarded.description).toBe("Meta tool description");
    }
  });

  it("returns denied-tool result as model-visible error content", async () => {
    const policy = makePolicy({ deniedTools: ["no_execute"] });
    const config = makeConfig({ policy });
    const executor = new FakeToolExecutor();
    const tool = makePiAgentTool({ name: "no_execute", label: "NoExecute" });

    const [guarded] = assembleGuardedTools(config, executor, [tool]);
    expect(guarded).toBeDefined();

    if (guarded) {
      const result = await guarded.execute("tc-deny", {}, undefined);

      // The result should have text content that the model can see
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      const text =
        typeof (result.content[0] as { text?: string })?.text === "string"
          ? (result.content[0] as { text: string }).text
          : "";
      expect(text).toContain("no_execute");
      expect(text.toLowerCase()).toContain("denied");

      // Executor must NOT be called
      expect(executor.calls.length).toBe(0);
    }
  });

  it("accepts null executor for tools that are self-contained", () => {
    const config = makeConfig();
    const tool = makePiAgentTool({ name: "standalone", label: "Standalone" });

    const guarded = assembleGuardedTools(config, null, [tool]);
    expect(guarded.length).toBe(1);
    expect(guarded[0]).toBeDefined();
    expect(guarded[0]?.name).toBe("standalone");
  });
});
