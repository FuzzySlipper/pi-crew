import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger, type GatewayEvent, type WorkerPolicy } from "@pi-crew/core";
import type { WorkerBinding } from "../../sessions/types.js";
import {
  assembleGuardedTools,
  createBeforeToolCallHook,
  type GuardedToolAssemblyConfig,
  type ToolExecutor,
} from "../../workers/guarded-tool-assembly.js";
import type { AgentTool, AgentToolResult } from "../../workers/guarded-tool-types.js";

function binding(): WorkerBinding {
  return {
    assignmentId: "2063",
    runId: "piw_path_policy",
    taskId: "2063",
    projectId: "pi-crew",
    role: "coder",
  };
}

function policy(overrides?: Partial<WorkerPolicy>): WorkerPolicy {
  const base = {
    policyId: "2063",
    rootPath: "/workspace/task",
    assignmentId: "2063",
    role: "coder",
    workdir: "/workspace/task",
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
    credentialScope: "none" as const,
    releaseOnCompletion: true,
    cleanupWorkdir: true,
    ...overrides,
  };
  return base;
}

function config(overrides?: Partial<GuardedToolAssemblyConfig>): GuardedToolAssemblyConfig {
  return {
    binding: binding(),
    sessionId: "session-paths",
    profileId: "spawned-coder",
    policy: policy(),
    eventBus: new FakeEventBus(),
    logger: new FakeLogger(),
    ...overrides,
  };
}

function beforeArgs(path: string): Parameters<ReturnType<typeof createBeforeToolCallHook>>[0] {
  return {
    toolCall: { type: "toolCall", id: "tc-path", name: "read_file", input: { path } },
    args: { path },
  };
}

class RecordingExecutor implements ToolExecutor {
  readonly calls: Array<{ name: string; params: Record<string, unknown> }> = [];

  callTool(name: string, params: Record<string, unknown>): Promise<{ ok: boolean; content: unknown[] }> {
    this.calls.push({ name, params });
    return Promise.resolve({ ok: true, content: [{ type: "text", text: "read" }] });
  }
}

function tool(): AgentTool {
  return {
    name: "read_file",
    label: "Read File",
    description: "Read a file",
    parameters: { type: "object" },
    execute(): Promise<AgentToolResult> {
      return Promise.resolve({ content: [{ type: "text", text: "direct" }], details: undefined });
    },
  };
}

describe("guarded filesystem path policy", () => {
  it("allows relative paths resolved under an allowed workdir subpath", async () => {
    const hook = createBeforeToolCallHook(config({
      policy: policy({ allowedPaths: ["/workspace/task/src"] }),
    }));

    await expect(hook(beforeArgs("src/index.ts"))).resolves.toBeUndefined();
  });

  it("denies traversal that escapes the workdir before execution", async () => {
    const eventBus = new FakeEventBus();
    const hook = createBeforeToolCallHook(config({
      eventBus,
      policy: policy({ allowedPaths: ["/workspace/task/src"] }),
    }));

    const result = await hook(beforeArgs("../secrets/key.txt"));

    expect(result?.block).toBe(true);
    const denied = eventBus.emitted.find((event: GatewayEvent) => event.event === "tool.denied");
    expect(denied?.payload.assignmentId).toBe("2063");
  });

  it("does not allow sibling prefixes that only start with an allowed path string", async () => {
    const hook = createBeforeToolCallHook(config({
      policy: policy({ allowedPaths: ["/workspace/task/src"] }),
    }));

    const result = await hook(beforeArgs("/workspace/task/src-not-allowed/file.ts"));

    expect(result?.block).toBe(true);
  });

  it("wrapper-level path denial prevents file tools from calling the executor", async () => {
    const eventBus = new FakeEventBus();
    const executor = new RecordingExecutor();
    const [guarded] = assembleGuardedTools(
      config({ eventBus, policy: policy({ denyPaths: ["/workspace/task/private"] }) }),
      executor,
      [tool()],
    );

    const result = await guarded?.execute("tc-private", { path: "private/secret.txt" });

    expect(executor.calls).toHaveLength(0);
    const first = result?.content[0];
    expect(first?.type).toBe("text");
    const text = first?.type === "text" ? (first as { text: string }).text : "";
    expect(text.toLowerCase()).toContain("denied");
  });
});
