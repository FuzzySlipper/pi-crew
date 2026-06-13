/** Tests for pre-run delegated profile runtime resolution. */

import { describe, expect, it } from "vitest";
import {
  FakeEventBus,
  FakeLogger,
  InMemoryHookRegistry,
  type DelegatedResult,
  type DelegationConstraints,
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
  type DelegatedChildRuntimeResolveInput,
} from "../../workers/delegated-spawn-lifecycle.js";

const parentRuntime: EffectiveDelegationRuntime = {
  profileId: "parent-profile",
  provider: "parent-provider",
  model: "parent-model",
};

const parentPolicy = createExecutionPolicy({
  policyId: "policy-parent",
  rootPath: "/workspace",
  allowedTools: ["spawn_subagent"],
  maxDurationMs: 60_000,
});

const parentConstraints: DelegationConstraints = { maxSpawnDepth: 2, maxConcurrentChildren: 2 };

describe("DelegatedSpawnLifecycle profile runtime resolution", () => {
  it("emits spawned visibility with runtime resolved by the child runner", async () => {
    const bridge = new CapturingBridge();
    const resolvedRuntime: EffectiveDelegationRuntime = {
      profileId: "child-profile",
      provider: "profile-provider",
      model: "profile-model",
    };
    const lifecycle = new DelegatedSpawnLifecycle({
      hookRegistry: new InMemoryHookRegistry(new FakeLogger()),
      delegationSessions: bridge,
      eventBus: new FakeEventBus(),
      logger: new FakeLogger(),
      childSessionId: () => "child-session-1",
      childRunner: new ResolvingRunner(resolvedRuntime),
    });

    const result = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "use profile-only runtime",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [],
      spawnRequest: {
        task: "use profile-only runtime",
        modelSelection: { profileId: "child-profile" },
      },
    });

    expect(result.ok && result.value.effectiveRuntime).toEqual(resolvedRuntime);
    expect(bridge.created[0]?.effectiveRuntime).toEqual(resolvedRuntime);
    const spawned = bridge.visibility.find((event) => event.eventType === "delegation.spawned");
    expect(spawned?.metadata?.["effectiveRuntime"]).toEqual(resolvedRuntime);
  });
});

class ResolvingRunner implements DelegatedChildRunner {
  constructor(private readonly resolvedRuntime: EffectiveDelegationRuntime) {}

  resolveEffectiveRuntime(
    _input: DelegatedChildRuntimeResolveInput,
  ): Promise<EffectiveDelegationRuntime> {
    return Promise.resolve(this.resolvedRuntime);
  }

  run(input: DelegatedChildRunInput): Promise<DelegatedResult> {
    return Promise.resolve({
      outcome: "success",
      summary: "child success",
      policyId: input.policy.policyId,
      childSessionId: input.childSession.sessionId,
      effectiveRuntime: input.effectiveRuntime,
      turnsUsed: 1,
      tokensConsumed: 7,
      durationMs: 11,
    });
  }
}

class CapturingBridge implements DelegationSessionBridge {
  readonly created: DelegatedSessionCreateRequest[] = [];
  readonly visibility: DelegationVisibilityEvent[] = [];

  getSession(sessionId: string): Promise<ServiceSessionView | null> {
    return Promise.resolve(sessionId === "parent-session" ? sessionView(sessionId) : null);
  }

  createDelegatedSession(request: DelegatedSessionCreateRequest): Promise<ServiceSessionView> {
    this.created.push(request);
    return Promise.resolve(
      sessionView("child-session-1", request.profileId, request.parentSessionId),
    );
  }

  listChildSessions(_parentSessionId: string): Promise<readonly ServiceSessionView[]> {
    return Promise.resolve([]);
  }

  countChildSessions(_parentSessionId: string): Promise<number> {
    return Promise.resolve(0);
  }

  getParentExecutionPolicy(_childSessionId: string): Promise<ExecutionPolicy | null> {
    return Promise.resolve(parentPolicy);
  }

  releaseChildSession(_childSessionId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }

  killChildSession(_childSessionId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }

  archiveChildSession(_childSessionId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }

  emitVisibilityEvent(event: DelegationVisibilityEvent): Promise<void> {
    this.visibility.push(event);
    return Promise.resolve();
  }
}

function sessionView(
  sessionId: string,
  profileId = "parent-profile",
  parentSessionId: string | null = null,
): ServiceSessionView {
  return {
    sessionId,
    profileId,
    kind: parentSessionId === null ? "worker" : "delegated",
    state: "active",
    parentSessionId,
    rootSessionId: parentSessionId ?? sessionId,
    lastActiveAt: "1970-01-01T00:00:01.000Z",
  };
}
