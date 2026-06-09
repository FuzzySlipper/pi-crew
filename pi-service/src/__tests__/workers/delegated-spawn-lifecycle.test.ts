/** Tests for service-level delegated session spawn lifecycle. */

import { describe, expect, it } from "vitest";
import {
  FakeEventBus,
  FakeLogger,
  InMemoryHookRegistry,
  type DelegatedResult,
  type DelegationConstraints,
  type DelegationLineage,
  type EffectiveDelegationRuntime,
  type ExecutionPolicy,
} from "@pi-crew/core";
import { createExecutionPolicy } from "@pi-crew/tools";
import type {
  DelegatedSessionCreateRequest,
  DelegationSessionBridge,
  DelegationVisibilityEvent,
  ServiceSessionView,
} from "../../extension-activator.js";
import {
  DelegatedSpawnLifecycle,
  type DelegatedChildRunInput,
  type DelegatedChildRunner,
} from "../../workers/delegated-spawn-lifecycle.js";
import { createDelegatedSpawnTool } from "../../workers/delegated-spawn-tool.js";

const parentPolicy = createExecutionPolicy({
  policyId: "policy-parent",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["spawn_subagent", "read_file", "context_status"],
  deniedTools: [],
  allowedHosts: ["den-srv"],
  deniedHosts: [],
  maxDurationMs: 60_000,
  maxTurnDurationMs: 10_000,
  idleTimeoutMs: 5_000,
  maxIterations: 4,
  maxTokensPerTurn: 8_000,
  credentialScope: "read_only",
});

const parentRuntime: EffectiveDelegationRuntime = {
  profileId: "parent-profile",
  provider: "parent-provider",
  model: "parent-model",
};

const alternateRuntime: EffectiveDelegationRuntime = {
  profileId: "child-profile",
  provider: "child-provider",
  model: "child-model",
};

const parentConstraints: DelegationConstraints = {
  maxSpawnDepth: 2,
  maxConcurrentChildren: 2,
};

describe("DelegatedSpawnLifecycle", () => {
  it("spawns a delegated child, runs it, and emits non-opaque visibility events", async () => {
    const eventBus = new FakeEventBus();
    const bridge = new FakeDelegationBridge();
    const runner = new VisibilityRunner("success");
    const lifecycle = createLifecycle({ eventBus, bridge, runner });

    const result = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "inspect task",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [parentRuntime, alternateRuntime],
      correlation: {
        assignmentId: "101",
        runId: "run-parent",
        taskId: "2169",
        profileId: "parent-profile",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("success");
    expect(result.value.effectiveRuntime).toEqual(parentRuntime);
    expect(bridge.created).toHaveLength(1);
    expect(bridge.created[0]?.profileId).toBe("parent-profile");
    expect(bridge.created[0]?.policy.policyId).toBe("delegated-child-session-1");
    expect(bridge.operations).toContain("release:child-session-1:completed");
    expect(bridge.operations).toContain("archive:child-session-1:completed");

    expect(eventBus.emitted.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "delegation.spawned",
        "delegation.turn_visible",
        "delegation.tool_visible",
        "delegation.completed",
      ]),
    );
    expect(bridge.visibility.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "delegation.spawned",
        "delegation.turn_visible",
        "delegation.tool_visible",
        "delegation.completed",
      ]),
    );
    expect(runner.inputs[0]?.lineage.childSessionId).toBe("child-session-1");
  });

  it("uses allowed child model overrides without mutating parent or sibling runtime", async () => {
    const bridge = new FakeDelegationBridge();
    const runner = new VisibilityRunner("success");
    const lifecycle = createLifecycle({ bridge, runner });

    const first = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "use alternate model",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [parentRuntime, alternateRuntime],
      spawnRequest: {
        task: "use alternate model",
        modelSelection: alternateRuntime,
      },
    });
    const second = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "inherit model",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [parentRuntime, alternateRuntime],
    });

    expect(first.ok && first.value.effectiveRuntime).toEqual(alternateRuntime);
    expect(second.ok && second.value.effectiveRuntime).toEqual(parentRuntime);
    expect(parentRuntime).toEqual({
      profileId: "parent-profile",
      provider: "parent-provider",
      model: "parent-model",
    });
    expect(bridge.created.map((request) => request.profileId)).toEqual([
      "child-profile",
      "parent-profile",
    ]);
  });

  it("fails closed before session creation for disallowed model overrides", async () => {
    const bridge = new FakeDelegationBridge();
    const lifecycle = createLifecycle({ bridge });

    const result = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "unknown model",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [parentRuntime],
      spawnRequest: {
        task: "unknown model",
        modelSelection: alternateRuntime,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported_model_selection");
    expect(bridge.created).toEqual([]);
  });

  it("fails closed for max-depth, concurrent-child, and hook gates", async () => {
    const depthDenied = await createLifecycle().spawn({
      parentSessionId: "parent-session",
      task: "too deep",
      parentPolicy,
      parentDelegationConstraints: { maxSpawnDepth: 0, maxConcurrentChildren: 2 },
      parentRuntime,
      allowedRuntimes: [parentRuntime],
    });
    expect(depthDenied.ok).toBe(false);
    if (depthDenied.ok) return;
    expect(depthDenied.error.code).toBe("max_depth_exceeded");

    const bridge = new FakeDelegationBridge({ childCount: 2 });
    const concurrentDenied = await createLifecycle({ bridge }).spawn({
      parentSessionId: "parent-session",
      task: "too many children",
      parentPolicy,
      parentDelegationConstraints: { maxSpawnDepth: 1, maxConcurrentChildren: 2 },
      parentRuntime,
      allowedRuntimes: [parentRuntime],
    });
    expect(concurrentDenied.ok).toBe(false);
    if (concurrentDenied.ok) return;
    expect(concurrentDenied.error.code).toBe("max_concurrent_children_exceeded");

    const hookRegistry = new InMemoryHookRegistry(new FakeLogger());
    hookRegistry.register(
      "before_session_create",
      () => ({
        proceed: false,
        reason: "spawn paused by governance",
      }),
      { name: "test-spawn-gate" },
    );
    const hookDenied = await createLifecycle({ hookRegistry }).spawn({
      parentSessionId: "parent-session",
      task: "hook denied",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [parentRuntime],
    });
    expect(hookDenied.ok).toBe(false);
    if (hookDenied.ok) return;
    expect(hookDenied.error.code).toBe("spawn_gate_denied");
    expect(hookDenied.error.message).toBe("spawn paused by governance");
  });

  it("exposes spawn_subagent as a structured tool error instead of throwing", async () => {
    const tool = createDelegatedSpawnTool({
      lifecycle: createLifecycle(),
      parentSessionId: "parent-session",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [parentRuntime],
    });

    const result = await tool.execute(
      "tool-call-1",
      {
        task: "bad override",
        modelSelection: alternateRuntime,
      },
      new AbortController().signal,
    );

    const content = result.content[0];
    expect(content?.type).toBe("text");
    expect(content?.type === "text" ? content.text : "").toContain("unsupported_model_selection");
    expect(isRecord(result.details) ? result.details["ok"] : null).toBe(false);
    expect(isRecord(result.details) ? result.details["code"] : null).toBe(
      "unsupported_model_selection",
    );
  });
});

function createLifecycle(
  overrides: {
    readonly bridge?: FakeDelegationBridge;
    readonly eventBus?: FakeEventBus;
    readonly hookRegistry?: InMemoryHookRegistry;
    readonly runner?: DelegatedChildRunner;
  } = {},
): DelegatedSpawnLifecycle {
  return new DelegatedSpawnLifecycle({
    hookRegistry: overrides.hookRegistry ?? new InMemoryHookRegistry(new FakeLogger()),
    delegationSessions: overrides.bridge ?? new FakeDelegationBridge(),
    eventBus: overrides.eventBus ?? new FakeEventBus(),
    logger: new FakeLogger(),
    childSessionId: () => "child-session-1",
    childRunner: overrides.runner ?? new VisibilityRunner("success"),
  });
}

class VisibilityRunner implements DelegatedChildRunner {
  readonly inputs: DelegatedChildRunInput[] = [];

  constructor(private readonly outcome: DelegatedResult["outcome"]) {}

  async run(input: DelegatedChildRunInput): Promise<DelegatedResult> {
    this.inputs.push(input);
    await input.emitTurnVisible({ turnNumber: 1, phase: "started" });
    await input.emitToolVisible({
      toolName: "read_file",
      toolCallId: "tool-1",
      phase: "called",
    });
    return {
      outcome: this.outcome,
      summary: `child ${this.outcome}`,
      policyId: input.policy.policyId,
      childSessionId: input.childSession.sessionId,
      effectiveRuntime: input.effectiveRuntime,
      turnsUsed: 1,
      tokensConsumed: 7,
      durationMs: 11,
    };
  }
}

class FakeDelegationBridge implements DelegationSessionBridge {
  readonly operations: string[] = [];
  readonly created: DelegatedSessionCreateRequest[] = [];
  readonly visibility: DelegationVisibilityEvent[] = [];
  readonly #childCount: number;

  constructor(options: { readonly childCount?: number } = {}) {
    this.#childCount = options.childCount ?? 0;
  }

  getSession(sessionId: string): Promise<ServiceSessionView | null> {
    this.operations.push(`get:${sessionId}`);
    if (sessionId !== "parent-session") return Promise.resolve(null);
    return Promise.resolve(sessionView({ sessionId, profileId: "parent-profile" }));
  }

  createDelegatedSession(request: DelegatedSessionCreateRequest): Promise<ServiceSessionView> {
    this.operations.push(`create:${request.parentSessionId}:${request.profileId}`);
    this.created.push(request);
    const lineage = readLineage(request.visibility);
    return Promise.resolve(
      sessionView({
        sessionId: lineage?.childSessionId ?? "child-session-1",
        profileId: request.profileId,
        parentSessionId: request.parentSessionId,
        rootSessionId: lineage?.rootSessionId ?? request.parentSessionId,
      }),
    );
  }

  listChildSessions(parentSessionId: string): Promise<readonly ServiceSessionView[]> {
    this.operations.push(`list:${parentSessionId}`);
    return Promise.resolve([]);
  }

  countChildSessions(parentSessionId: string): Promise<number> {
    this.operations.push(`count:${parentSessionId}`);
    return Promise.resolve(this.#childCount);
  }

  getParentExecutionPolicy(childSessionId: string): Promise<ExecutionPolicy | null> {
    this.operations.push(`policy:${childSessionId}`);
    return Promise.resolve(parentPolicy);
  }

  releaseChildSession(childSessionId: string, reason: string): Promise<void> {
    this.operations.push(`release:${childSessionId}:${reason}`);
    return Promise.resolve();
  }

  killChildSession(childSessionId: string, reason: string): Promise<void> {
    this.operations.push(`kill:${childSessionId}:${reason}`);
    return Promise.resolve();
  }

  archiveChildSession(childSessionId: string, reason: string): Promise<void> {
    this.operations.push(`archive:${childSessionId}:${reason}`);
    return Promise.resolve();
  }

  emitVisibilityEvent(event: DelegationVisibilityEvent): Promise<void> {
    this.operations.push(`visibility:${event.eventType}:${event.sessionId}`);
    this.visibility.push(event);
    return Promise.resolve();
  }
}

function sessionView(input: {
  readonly sessionId: string;
  readonly profileId: string;
  readonly parentSessionId?: string | null;
  readonly rootSessionId?: string;
}): ServiceSessionView {
  return {
    sessionId: input.sessionId,
    profileId: input.profileId,
    kind: input.parentSessionId === undefined ? "worker" : "delegated",
    state: "active",
    parentSessionId: input.parentSessionId ?? null,
    rootSessionId: input.rootSessionId ?? input.sessionId,
    lastActiveAt: "1970-01-01T00:00:01.000Z",
  };
}

function readLineage(
  value: Readonly<Record<string, unknown>> | undefined,
): DelegationLineage | null {
  const lineage = value?.["lineage"];
  if (typeof lineage !== "object" || lineage === null) return null;
  return lineage as DelegationLineage;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
