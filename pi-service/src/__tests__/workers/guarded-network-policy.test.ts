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
    assignmentId: "2064",
    runId: "piw_host_policy",
    taskId: "2064",
    projectId: "pi-crew",
    role: "coder",
  };
}

function policy(overrides?: Partial<WorkerPolicy>): WorkerPolicy {
  const base = {
    policyId: "2064",
    rootPath: "/workspace/task",
    assignmentId: "2064",
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
    sessionId: "session-hosts",
    profileId: "spawned-coder",
    policy: policy(),
    eventBus: new FakeEventBus(),
    logger: new FakeLogger(),
    ...overrides,
  };
}

function beforeArgs(url: string): Parameters<ReturnType<typeof createBeforeToolCallHook>>[0] {
  return {
    toolCall: { type: "toolCall", id: "tc-host", name: "http_request", input: { url } },
    args: { url },
  };
}

class RecordingExecutor implements ToolExecutor {
  readonly calls: Array<{ name: string; params: Record<string, unknown> }> = [];

  callTool(name: string, params: Record<string, unknown>): Promise<{ ok: boolean; content: unknown[] }> {
    this.calls.push({ name, params });
    return Promise.resolve({ ok: true, content: [{ type: "text", text: "ok" }] });
  }
}

function httpTool(): AgentTool {
  return {
    name: "http_request",
    label: "HTTP Request",
    description: "Call HTTP",
    parameters: { type: "object" },
    execute(): Promise<AgentToolResult> {
      return Promise.resolve({ content: [{ type: "text", text: "direct" }], details: undefined });
    },
  };
}

describe("guarded network host policy", () => {
  it("allows URL calls to explicitly allowed hosts despite case, port, and credentials", async () => {
    const hook = createBeforeToolCallHook(config({
      policy: policy({ allowedHosts: ["api.example.com"] }),
    }));

    await expect(hook(beforeArgs("https://user:pass@API.EXAMPLE.com:8443/v1"))).resolves.toBeUndefined();
  });

  it("denies hosts in deniedHosts before opening a connection", async () => {
    const eventBus = new FakeEventBus();
    const hook = createBeforeToolCallHook(config({
      eventBus,
      policy: policy({ deniedHosts: ["metadata.google.internal"] }),
    }));

    const result = await hook(beforeArgs("http://metadata.google.internal/computeMetadata/v1"));

    expect(result?.block).toBe(true);
    const denied = eventBus.emitted.find((event: GatewayEvent) => event.event === "tool.denied");
    expect(denied?.payload.assignmentId).toBe("2064");
  });

  it("denies hosts outside a non-empty allowlist", async () => {
    const hook = createBeforeToolCallHook(config({
      policy: policy({ allowedHosts: ["den-srv", "192.168.1.10"] }),
    }));

    const result = await hook(beforeArgs("https://example.com/resource"));

    expect(result?.block).toBe(true);
  });

  it("denies localhost aliases before outbound tool execution", async () => {
    const hook = createBeforeToolCallHook(config({
      policy: policy({ deniedHosts: ["localhost"] }),
    }));

    const result = await hook(beforeArgs("http://[::1]:9236/health"));

    expect(result?.block).toBe(true);
  });

  it("wrapper-level host denial prevents outbound tools from calling the executor", async () => {
    const executor = new RecordingExecutor();
    const [guarded] = assembleGuardedTools(
      config({ policy: policy({ allowedHosts: ["den-srv"] }) }),
      executor,
      [httpTool()],
    );

    const result = await guarded?.execute("tc-host", { url: "http://evil.example/path" });

    expect(executor.calls).toHaveLength(0);
    const first = result?.content[0];
    const text = first?.type === "text" ? (first as { text: string }).text : "";
    expect(text.toLowerCase()).toContain("denied");
  });
});
