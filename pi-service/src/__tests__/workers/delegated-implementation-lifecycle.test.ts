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
} from "../../workers/delegated-spawn-lifecycle.js";

const parentPolicy = createExecutionPolicy({
  policyId: "parent-policy",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["spawn_subagent", "terminal"],
  deniedTools: [],
  allowedHosts: ["den-srv"],
  deniedHosts: [],
  maxDurationMs: 1_000,
  maxTurnDurationMs: 100,
  idleTimeoutMs: 50,
  maxIterations: 6,
  maxTokensPerTurn: 8_000,
  credentialScope: "bounded_write",
});

const parentRuntime: EffectiveDelegationRuntime = {
  profileId: "coder-profile",
  provider: "den-router",
  model: "gpt",
};
const parentConstraints: DelegationConstraints = { maxSpawnDepth: 2 };

describe("delegated implementation lifecycle validation", () => {
  it("projects lifecycle success as evidence validation failure when implementation evidence is missing", async () => {
    const eventBus = new FakeEventBus();
    const bridge = new FakeDelegationBridge();
    const lifecycle = new DelegatedSpawnLifecycle({
      hookRegistry: new InMemoryHookRegistry(new FakeLogger()),
      delegationSessions: bridge,
      eventBus,
      logger: new FakeLogger(),
      childSessionId: () => "child-session-1",
      childRunner: new StaticRunner(childResult({ outcome: "success", summary: "coded it" })),
    });

    const result = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "implement #2401",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      spawnRequest: {
        task: "implement #2401",
        expectedResultSchema: "implementation",
        requiredEvidence: {
          taskIds: ["2401"],
          requireBranch: true,
          requireHeadCommit: true,
          requireTests: true,
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("failure");
    expect(result.value.failureCategory).toBe("insufficient_evidence");
    expect(completedResult(eventBus)?.failureCategory).toBe("insufficient_evidence");
    expect(
      bridge.visibility.find((event) => event.eventType === "delegation.completed")?.metadata,
    ).toMatchObject({
      result: { outcome: "failure", failureCategory: "insufficient_evidence" },
    });
    expect(bridge.operations).toContain("release:child-session-1:failed");
  });
});

function completedResult(eventBus: FakeEventBus): DelegatedResult | undefined {
  const completed = eventBus.emitted.find((event) => event.event === "delegation.completed");
  const payload = completed?.payload as { readonly result?: DelegatedResult } | undefined;
  return payload?.result;
}

function childResult(input: Partial<DelegatedResult>): DelegatedResult {
  return {
    outcome: "success",
    summary: "child summary",
    policyId: "delegated",
    childSessionId: "child",
    ...input,
  };
}

class StaticRunner implements DelegatedChildRunner {
  constructor(private readonly result: DelegatedResult) {}

  run(input: DelegatedChildRunInput): Promise<DelegatedResult> {
    return Promise.resolve({
      ...this.result,
      policyId: input.policy.policyId,
      childSessionId: input.childSession.sessionId,
      effectiveRuntime: input.effectiveRuntime,
    });
  }
}

class FakeDelegationBridge implements DelegationSessionBridge {
  readonly operations: string[] = [];
  readonly visibility: DelegationVisibilityEvent[] = [];

  getSession(sessionId: string): Promise<ServiceSessionView | null> {
    return Promise.resolve(
      sessionId === "parent-session" ? sessionView(sessionId, "worker") : null,
    );
  }

  createDelegatedSession(request: DelegatedSessionCreateRequest): Promise<ServiceSessionView> {
    this.operations.push(
      `create:${request.parentSessionId}:${request.profileId ?? "unknown-profile"}`,
    );
    return Promise.resolve(sessionView(request.sessionId, "delegated", request.parentSessionId));
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

function sessionView(
  sessionId: string,
  kind: ServiceSessionView["kind"],
  parentSessionId: string | null = null,
): ServiceSessionView {
  return {
    sessionId,
    profileId: "coder-profile",
    kind,
    state: "active",
    parentSessionId,
    rootSessionId: parentSessionId ?? sessionId,
    lastActiveAt: "1970-01-01T00:00:00.000Z",
  };
}
