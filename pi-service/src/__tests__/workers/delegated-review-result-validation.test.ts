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
  policyId: "parent-policy",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["spawn_subagent", "get_task", "get_thread"],
  deniedTools: [],
  allowedHosts: ["den-srv"],
  deniedHosts: [],
  maxDurationMs: 1_000,
  maxTurnDurationMs: 100,
  idleTimeoutMs: 50,
  maxIterations: 6,
  maxTokensPerTurn: 8_000,
  credentialScope: "read_only",
});

const parentRuntime: EffectiveDelegationRuntime = {
  profileId: "reviewer-profile",
  provider: "den-router",
  model: "gpt",
};

const parentConstraints: DelegationConstraints = { maxSpawnDepth: 2 };

describe("delegated review result validation", () => {
  it("turns wrapper-only review success into insufficient evidence failure", async () => {
    const { result, eventBus, bridge } = await spawnReview(
      childResult({ outcome: "success", summary: "review complete" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("failure");
    expect(result.value.failureCategory).toBe("insufficient_evidence");
    expect(result.value.evidenceChecked).toBe(false);
    expect(result.value.safeExcerpt).toContain("missing structured review result");
    expect(bridge.operations).toContain("release:child-session-1:failed");
    expect(completedResult(eventBus)?.failureCategory).toBe("insufficient_evidence");
  });

  it("turns malformed review findings into insufficient evidence failure", async () => {
    const { result } = await spawnReview(
      childResult({
        outcome: "success",
        summary: "malformed review",
        review: {
          status: "accepted",
          evidenceHandles: [messageEvidence(14424)],
          taskDecisions: [
            {
              taskId: "2360",
              decision: "accepted",
              summary: "looks good",
              evidenceHandles: [messageEvidence(14424)],
              findings: [{ severity: "major", category: "correctness", summary: "" }],
            },
          ],
        },
        evidenceChecked: true,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("failure");
    expect(result.value.failureCategory).toBe("insufficient_evidence");
    expect(result.value.safeExcerpt).toContain("finding for 2360 summary is required");
  });

  it("accepts valid review result and preserves safe review evidence", async () => {
    const { result, bridge } = await spawnReview(
      childResult({
        outcome: "success",
        summary: "review accepted",
        review: {
          status: "accepted",
          evidenceHandles: [messageEvidence(14424), messageEvidence(14425)],
          taskDecisions: [
            {
              taskId: "2344",
              decision: "accepted",
              summary: "Admin null-auth mode has evidence.",
              evidenceHandles: [messageEvidence(14424)],
            },
            {
              taskId: "2345",
              decision: "accepted",
              summary: "Projection sink behavior has evidence.",
              evidenceHandles: [messageEvidence(14425)],
            },
          ],
        },
        evidenceChecked: true,
        safeExcerpt: "review summary excerpt",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("success");
    expect(result.value.review?.taskDecisions.map((decision) => decision.taskId)).toEqual([
      "2344",
      "2345",
    ]);
    expect(result.value.safeExcerpt).toBe("review summary excerpt");
    expect(bridge.operations).toContain("release:child-session-1:completed");
  });

  it("requires a decision for each requested task", async () => {
    const { result } = await spawnReview(
      childResult({
        outcome: "success",
        summary: "partial review",
        review: {
          status: "accepted",
          evidenceHandles: [messageEvidence(14424)],
          taskDecisions: [
            {
              taskId: "2344",
              decision: "accepted",
              summary: "Admin null-auth mode has evidence.",
              evidenceHandles: [messageEvidence(14424)],
            },
          ],
        },
        evidenceChecked: true,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("failure");
    expect(result.value.safeExcerpt).toContain("missing per-task review decision for 2345");
  });

  it("keeps ordinary spawn_subagent behavior when review schema is absent", async () => {
    const bridge = new FakeDelegationBridge();
    const lifecycle = createLifecycle({
      bridge,
      runner: new StaticRunner(childResult({ outcome: "success" })),
    });
    const result = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "ordinary child",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("success");
    expect(result.value.failureCategory).toBeUndefined();
    expect(bridge.operations).toContain("release:child-session-1:completed");
  });

  it("does not run review validation for implementation-mode required evidence", async () => {
    const lifecycle = createLifecycle({
      bridge: new FakeDelegationBridge(),
      runner: new StaticRunner(childResult({ outcome: "success" })),
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
        requiredEvidence: { taskIds: ["2401"], requireBranch: true },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.safeExcerpt).not.toContain("missing structured review result");
  });
});

async function spawnReview(result: DelegatedResult): Promise<{
  readonly result: Awaited<ReturnType<DelegatedSpawnLifecycle["spawn"]>>;
  readonly eventBus: FakeEventBus;
  readonly bridge: FakeDelegationBridge;
}> {
  const eventBus = new FakeEventBus();
  const bridge = new FakeDelegationBridge();
  const lifecycle = createLifecycle({ bridge, eventBus, runner: new StaticRunner(result) });
  const spawnResult = await lifecycle.spawn({
    parentSessionId: "parent-session",
    task: "review #2344 and #2345",
    parentPolicy,
    parentDelegationConstraints: parentConstraints,
    parentRuntime,
    spawnRequest: {
      task: "review #2344 and #2345",
      expectedResultSchema: "review",
      requiredEvidence: { taskIds: ["2344", "2345"] },
    },
  });
  return { result: spawnResult, eventBus, bridge };
}

function createLifecycle(input: {
  readonly bridge: FakeDelegationBridge;
  readonly eventBus?: FakeEventBus;
  readonly runner: DelegatedChildRunner;
}): DelegatedSpawnLifecycle {
  return new DelegatedSpawnLifecycle({
    hookRegistry: new InMemoryHookRegistry(new FakeLogger()),
    delegationSessions: input.bridge,
    eventBus: input.eventBus ?? new FakeEventBus(),
    logger: new FakeLogger(),
    childSessionId: () => "child-session-1",
    childRunner: input.runner,
  });
}

function completedResult(eventBus: FakeEventBus): DelegatedResult | undefined {
  const completed = eventBus.emitted.find((event) => event.event === "delegation.completed");
  const payload = completed?.payload as { readonly result?: DelegatedResult } | undefined;
  return payload?.result;
}

function childResult(input: Partial<DelegatedResult>): DelegatedResult {
  return {
    outcome: "success",
    summary: "child summary",
    policyId: "delegated-child-session-1",
    childSessionId: "child-session-1",
    ...input,
  };
}

function messageEvidence(messageId: number): {
  readonly type: "den_message";
  readonly messageId: number;
  readonly description: string;
} {
  return { type: "den_message", messageId, description: `message ${messageId}` };
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
    this.operations.push(`create:${request.parentSessionId}:${request.profileId}`);
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
    profileId: "reviewer-profile",
    kind,
    state: "active",
    parentSessionId,
    rootSessionId: parentSessionId ?? sessionId,
    lastActiveAt: "1970-01-01T00:00:00.000Z",
  };
}
