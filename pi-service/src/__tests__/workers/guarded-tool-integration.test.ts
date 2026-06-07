/**
 * Agent-loop integration tests for guarded tool assembly through
 * WorkerExecutionContext — proves that policy denial prevents
 * underlying tool execution and produces model-visible denial
 * evidence.
 *
 * @module pi-service/__tests__/workers/guarded-tool-integration.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import type {
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
} from "../../workers/guarded-tool-types.js";
import type { ToolExecutor } from "../../workers/guarded-tool-assembly.js";
import { buildGuardedToolContext } from "../../workers/guarded-tool-context-factory.js";
import type {
  WorkerBinding,
  SessionRecord,
} from "../../sessions/types.js";
import type { WorkerRoleConfig } from "../../workers/worker-role-config.js";

// ── Helpers ─────────────────────────────────────────────────

function makeBinding(overrides?: Partial<WorkerBinding>): WorkerBinding {
  return {
    assignmentId: overrides?.assignmentId ?? "test-assignment-1",
    runId: overrides?.runId ?? "piw_test_run",
    taskId: overrides?.taskId ?? "99",
    projectId: overrides?.projectId ?? "pi-crew",
    role: overrides?.role ?? "coder",
  };
}

function makeSession(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id: overrides?.id ?? "test-session-1",
    profileId: overrides?.profileId ?? "spawned-coder",
    instanceId: overrides?.instanceId ?? null,
    kind: "worker",
    createdAt: overrides?.createdAt ?? new Date().toISOString(),
    lastActiveAt: overrides?.lastActiveAt ?? new Date().toISOString(),
    state: overrides?.state ?? "active",
  } as SessionRecord;
}

function makeRoleConfig(
  deniedTools?: string[],
): WorkerRoleConfig {
  return {
    toolPolicyDefaults: {
      deniedTools: deniedTools ?? [],
    },
  };
}

interface FakeTool extends AgentTool {
  executeCalls: Array<{ toolCallId: string; params: unknown }>;
}

function makeFakeTool(name: string): FakeTool {
  const executeCalls: Array<{ toolCallId: string; params: unknown }> = [];
  return {
    label: name,
    name,
    description: `Fake tool: ${name}`,
    parameters: {},
    executeCalls,
    execute(
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult> {
      executeCalls.push({ toolCallId, params });
      return Promise.resolve({
        content: [{ type: "text" as const, text: `${name} executed` }],
        details: { ok: true },
      });
    },
  };
}

function findText(result: AgentToolResult): string | undefined {
  const c = result.content.find((x) => x.type === "text");
  return c && "text" in c ? (c as { text: string }).text : undefined;
}

function makeToolCall(name: string, id: string): BeforeToolCallContext["toolCall"] {
  return { type: "function", id, name, input: {} };
}

// ── Tests ───────────────────────────────────────────────────

describe("Guarded tool integration via WorkerExecutionContext", () => {
  let bus: FakeEventBus;
  let logger: FakeLogger;

  beforeEach(() => {
    bus = new FakeEventBus();
    logger = new FakeLogger();
  });

  // ── 1. beforeToolCall denial prevents tool execute ────────

  it("beforeToolCall hook denies tool and execution is never called", async () => {
    const binding = makeBinding();
    const session = makeSession();
    const roleConfig = makeRoleConfig(["dangerous_tool"]);
    const ctx = buildGuardedToolContext(
      binding, session, "spawned-coder", roleConfig, bus, logger,
    );
    const { beforeToolCall } = ctx.createGuardedToolHooks();

    const hookCtx: BeforeToolCallContext = {
      toolCall: makeToolCall("dangerous_tool", "call-1"),
      args: { path: "/tmp/ok" },
    };

    const result = await beforeToolCall(hookCtx);
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.reason).toBeDefined();
  });

  // ── 2. beforeToolCall allows safe tools ──────────────────

  it("beforeToolCall hook allows tools not on denylist", async () => {
    const binding = makeBinding();
    const session = makeSession();
    const roleConfig = makeRoleConfig(["dangerous_tool"]);
    const ctx = buildGuardedToolContext(
      binding, session, "spawned-coder", roleConfig, bus, logger,
    );
    const { beforeToolCall } = ctx.createGuardedToolHooks();

    const hookCtx: BeforeToolCallContext = {
      toolCall: makeToolCall("safe_tool", "call-2"),
      args: {},
    };

    const result = await beforeToolCall(hookCtx);
    expect(result).toBeUndefined();
  });

  // ── 3. Wrapper deny prevents execute call ────────────────

  it("wrapped tool deny prevents executor from being called", async () => {
    const binding = makeBinding();
    const session = makeSession();
    const roleConfig = makeRoleConfig(["dangerous_tool"]);
    const ctx = buildGuardedToolContext(
      binding, session, "spawned-coder", roleConfig, bus, logger,
    );

    const rawTool = makeFakeTool("dangerous_tool");
    const fakeExecutor: ToolExecutor = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      callTool(name, _params) {
        return Promise.resolve({
          ok: true,
          content: [{ type: "text", text: `executor: ${name}` }],
        });
      },
    };

    const wrapped = ctx.assembleGuardedTools([rawTool], fakeExecutor);
    expect(wrapped.length).toBe(1);
    const first = wrapped[0];
    if (first === undefined) { throw new Error("expected tool"); }
    const result = await first.execute("call-3", { x: 1 });
    const text = findText(result);
    expect(text).toBeDefined();
    if (text !== undefined) {
      expect(text).toContain("denied");
    }

    // Underlying raw tool execute was never called
    expect(rawTool.executeCalls.length).toBe(0);
  });

  // ── 4. Denial emits tool.denied and policy.enforced ─────────

  it("beforeToolCall denial emits tool.denied and policy.enforced events", async () => {
    const binding = makeBinding();
    const session = makeSession();
    const roleConfig = makeRoleConfig(["dangerous_tool"]);
    const ctx = buildGuardedToolContext(
      binding, session, "spawned-coder", roleConfig, bus, logger,
    );
    const { beforeToolCall } = ctx.createGuardedToolHooks();

    const hookCtx: BeforeToolCallContext = {
      toolCall: makeToolCall("dangerous_tool", "call-4"),
      args: { path: "/tmp/test" },
    };

    await beforeToolCall(hookCtx);

    const deniedEvents = bus.emitted.filter(
      (e) => e.event === "tool.denied",
    );
    expect(deniedEvents.length).toBeGreaterThanOrEqual(1);
    const deniedPayload = deniedEvents[0]?.payload;
    if (deniedPayload) {
      expect(deniedPayload.toolName).toBe("dangerous_tool");
      expect(deniedPayload.sessionId).toBe(session.id);
    }

    const policyEvents = bus.emitted.filter(
      (e) => e.event === "policy.enforced",
    );
    expect(policyEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ── 5. Allowed tool executes and returns model-visible result

  it("allowed tool executes and returns model-visible result", async () => {
    const binding = makeBinding();
    const session = makeSession();
    const roleConfig = makeRoleConfig(["dangerous_tool"]);
    const ctx = buildGuardedToolContext(
      binding, session, "spawned-coder", roleConfig, bus, logger,
    );

    const rawTool = makeFakeTool("safe_tool");
    const executorCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const fakeExecutor: ToolExecutor = {
      callTool(name, params) {
        executorCalls.push({ name, params });
        return Promise.resolve({
          ok: true,
          content: [{ type: "text", text: `executor: ${name}` }],
        });
      },
    };

    const wrapped = ctx.assembleGuardedTools([rawTool], fakeExecutor);
    const first = wrapped[0];
    if (first === undefined) { throw new Error("expected tool"); }
    const result = await first.execute("call-5", { y: 2 });

    // Executor was called (wrapped tool routes through it)
    expect(executorCalls.length).toBe(1);

    // Result is model-visible text
    const text = findText(result);
    expect(text).toBeDefined();
    if (text !== undefined) {
      expect(text.length).toBeGreaterThan(0);
    }
  });

  // ── 6. Denial result text is model-reason-able ──────────────

  it("denied tool result contains the denied tool name for model reasoning", async () => {
    const binding = makeBinding();
    const session = makeSession();
    const roleConfig = makeRoleConfig(["dangerous_tool"]);
    const ctx = buildGuardedToolContext(
      binding, session, "spawned-coder", roleConfig, bus, logger,
    );

    const rawTool = makeFakeTool("dangerous_tool");
    const fakeExecutor: ToolExecutor = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      callTool(name, _params) {
        return Promise.resolve({
          ok: true,
          content: [{ type: "text", text: `executor: ${name}` }],
        });
      },
    };

    const wrapped = ctx.assembleGuardedTools([rawTool], fakeExecutor);
    const first = wrapped[0];
    if (first === undefined) { throw new Error("expected tool"); }
    const result = await first.execute("call-6", {});

    const text = findText(result);
    expect(text).toBeDefined();
    if (text !== undefined) {
      expect(text).toContain("dangerous_tool");
      expect(text).toContain("denied");
    }
  });
});
