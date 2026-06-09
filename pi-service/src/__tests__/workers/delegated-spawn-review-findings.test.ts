/** Regression tests for #2169 review findings. */

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

const parentPolicy = createExecutionPolicy({
  policyId: "policy-parent",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["spawn_subagent", "read_file", "context_status"],
  deniedTools: [],
  allowedHosts: ["den-srv"],
  deniedHosts: [],
  maxDurationMs: 50,
  maxTurnDurationMs: 10,
  idleTimeoutMs: 5,
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
  profileId: "parent-profile",
  provider: "alternate-provider",
  model: "alternate-model",
};

const parentConstraints: DelegationConstraints = {
  maxSpawnDepth: 2,
  maxConcurrentChildren: 2,
};

describe("DelegatedSpawnLifecycle review finding regressions", () => {
  it("passes effective runtime and derived constraints into concrete child creation and runner", async () => {
    const bridge = new FakeDelegationBridge();
    const runner = new CapturingRunner({ outcome: "success" });
    const lifecycle = createLifecycle({ bridge, runner });

    const result = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "use alternate runtime",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [parentRuntime, alternateRuntime],
      spawnRequest: { task: "use alternate runtime", modelSelection: alternateRuntime },
    });

    expect(result.ok).toBe(true);
    expect(bridge.created[0]?.effectiveRuntime).toEqual(alternateRuntime);
    expect(bridge.created[0]?.delegationConstraints).toEqual({
      maxSpawnDepth: 1,
      maxConcurrentChildren: 2,
    });
    expect(runner.inputs[0]?.delegationConstraints).toEqual({
      maxSpawnDepth: 1,
      maxConcurrentChildren: 2,
    });
  });

  it("enforces child timeout instead of waiting for the runner forever", async () => {
    const eventBus = new FakeEventBus();
    const bridge = new FakeDelegationBridge();
    const lifecycle = createLifecycle({
      bridge,
      eventBus,
      runner: new NeverResolvingRunner(),
    });

    const result = await Promise.race([
      lifecycle.spawn({
        parentSessionId: "parent-session",
        task: "hang",
        parentPolicy,
        parentDelegationConstraints: parentConstraints,
        parentRuntime,
        allowedRuntimes: [parentRuntime],
        spawnRequest: { task: "hang", timeoutMs: 1 },
      }),
      wait(100).then(() => "hung" as const),
    ]);

    expect(result).not.toBe("hung");
    if (result === "hung") return;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("timeout");
    expect(bridge.operations).toContain("kill:child-session-1:timeout");
    expect(bridge.operations).toContain("archive:child-session-1:timeout");
    expect(eventBus.emitted.map((event) => event.event)).toEqual(
      expect.arrayContaining(["delegation.timeout", "delegation.killed", "delegation.completed"]),
    );
  });

  it("emits killed visibility and cleanup for killed child results", async () => {
    const eventBus = new FakeEventBus();
    const bridge = new FakeDelegationBridge();
    const lifecycle = createLifecycle({
      bridge,
      eventBus,
      runner: new CapturingRunner({ outcome: "killed" }),
    });

    const result = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "kill child",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [parentRuntime],
    });

    expect(result.ok).toBe(true);
    expect(bridge.operations).toContain("kill:child-session-1:killed");
    expect(bridge.operations).toContain("archive:child-session-1:killed");
    expect(eventBus.emitted.map((event) => event.event)).toContain("delegation.killed");
    expect(bridge.visibility.map((event) => event.eventType)).toContain("delegation.killed");
  });
});

function createLifecycle(
  overrides: {
    readonly bridge?: FakeDelegationBridge;
    readonly eventBus?: FakeEventBus;
    readonly runner?: DelegatedChildRunner;
  } = {},
): DelegatedSpawnLifecycle {
  return new DelegatedSpawnLifecycle({
    hookRegistry: new InMemoryHookRegistry(new FakeLogger()),
    delegationSessions: overrides.bridge ?? new FakeDelegationBridge(),
    eventBus: overrides.eventBus ?? new FakeEventBus(),
    logger: new FakeLogger(),
    childSessionId: () => "child-session-1",
    childRunner: overrides.runner ?? new CapturingRunner({ outcome: "success" }),
  });
}

class CapturingRunner implements DelegatedChildRunner {
  readonly inputs: DelegatedChildRunInput[] = [];

  constructor(private readonly result: { readonly outcome: DelegatedResult["outcome"] }) {}

  run(input: DelegatedChildRunInput): Promise<DelegatedResult> {
    this.inputs.push(input);
    return Promise.resolve({
      outcome: this.result.outcome,
      summary: `child ${this.result.outcome}`,
      policyId: input.policy.policyId,
      childSessionId: input.childSession.sessionId,
      effectiveRuntime: input.effectiveRuntime,
      turnsUsed: 1,
      tokensConsumed: 7,
      durationMs: 11,
    });
  }
}

class NeverResolvingRunner implements DelegatedChildRunner {
  run(): Promise<DelegatedResult> {
    return new Promise(() => undefined);
  }
}

class FakeDelegationBridge implements DelegationSessionBridge {
  readonly operations: string[] = [];
  readonly created: DelegatedSessionCreateRequest[] = [];
  readonly visibility: DelegationVisibilityEvent[] = [];

  getSession(sessionId: string): Promise<ServiceSessionView | null> {
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

  listChildSessions(): Promise<readonly ServiceSessionView[]> {
    return Promise.resolve([]);
  }

  countChildSessions(): Promise<number> {
    return Promise.resolve(0);
  }

  getParentExecutionPolicy(): Promise<ExecutionPolicy | null> {
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
