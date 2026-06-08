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

function policy(overrides?: Partial<WorkerPolicy>): WorkerPolicy {
  return {
    assignmentId: "2065",
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

function binding(): WorkerBinding {
  return {
    assignmentId: "2065",
    runId: "piw_credential_scope",
    taskId: "2065",
    projectId: "pi-crew",
    role: "coder",
  };
}

function config(overrides?: Partial<GuardedToolAssemblyConfig>): GuardedToolAssemblyConfig {
  return {
    binding: binding(),
    sessionId: "session-credential",
    profileId: "spawned-coder",
    policy: policy(),
    eventBus: new FakeEventBus(),
    logger: new FakeLogger(),
    ...overrides,
  };
}

function beforeCtx(args: unknown): Parameters<ReturnType<typeof createBeforeToolCallHook>>[0] {
  return {
    toolCall: {
      type: "toolCall",
      id: "tc-credential",
      name: "credential_tool",
      input: args,
    },
    args,
  };
}

class FakeExecutor implements ToolExecutor {
  calls = 0;

  callTool(): Promise<{ ok: boolean; content: readonly unknown[]; error?: string }> {
    this.calls += 1;
    return Promise.resolve({ ok: true, content: [{ type: "text", text: "executed" }] });
  }
}

function tool(): AgentTool {
  return {
    name: "credential_tool",
    label: "Credential Tool",
    description: "uses credentials when requested",
    parameters: { type: "object" },
    execute: (): Promise<AgentToolResult> => Promise.resolve({ content: [{ type: "text", text: "raw" }], details: undefined }),
  };
}

describe("guarded credential policy", () => {
  it("allows no-credential calls when credentialScope is none", async () => {
    const hook = createBeforeToolCallHook(config({ policy: policy({ credentialScope: "none" }) }));

    const result = await hook(beforeCtx({ prompt: "status" }));

    expect(result).toBeUndefined();
  });

  it("denies read-only credential access when credentialScope is none", async () => {
    const eventBus = new FakeEventBus();
    const hook = createBeforeToolCallHook(config({ eventBus, policy: policy({ credentialScope: "none" }) }));

    const result = await hook(beforeCtx({ credentialAccess: "read_only" }));

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("read_only");
    const events = eventBus.emitted.filter((event: GatewayEvent) => event.event === "policy.enforced");
    expect(events[0]?.payload).toMatchObject({ checkKind: "credential", allowed: false });
    expect(JSON.stringify(events[0]?.payload)).not.toContain("secret-value");
  });

  it("allows read-only credential access but denies write access under read_only scope", async () => {
    const hook = createBeforeToolCallHook(config({ policy: policy({ credentialScope: "read_only" }) }));

    await expect(hook(beforeCtx({ credentialAccess: "read_only" }))).resolves.toBeUndefined();
    await expect(hook(beforeCtx({ credentialAccess: "bounded_write" }))).resolves.toMatchObject({ block: true });
  });

  it("allows bounded-write credential access under bounded_write scope", async () => {
    const executor = new FakeExecutor();
    const [guarded] = assembleGuardedTools(
      config({ policy: policy({ credentialScope: "bounded_write" }) }),
      executor,
      [tool()],
    );

    const result = await guarded?.execute("tc-write", { credentialWrite: true }, undefined);

    expect(result?.content[0]).toMatchObject({ type: "text", text: "executed" });
    expect(executor.calls).toBe(1);
  });

  it("denies wrapper-level full credential access before executor dispatch", async () => {
    const executor = new FakeExecutor();
    const [guarded] = assembleGuardedTools(
      config({ policy: policy({ credentialScope: "bounded_write" }) }),
      executor,
      [tool()],
    );

    const result = await guarded?.execute("tc-full", { credentialAccess: "full" }, undefined);

    expect(result?.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(result)).toContain("denied");
    expect(executor.calls).toBe(0);
  });

  it("fails closed for missing or unknown credential policy scope", async () => {
    const invalidPolicy = { ...policy(), credentialScope: "mystery" } as unknown as WorkerPolicy;
    const hook = createBeforeToolCallHook(config({ policy: invalidPolicy }));

    const result = await hook(beforeCtx({ prompt: "status" }));

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("unknown credential scope");
  });
});
