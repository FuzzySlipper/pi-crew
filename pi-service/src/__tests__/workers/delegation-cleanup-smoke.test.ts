/** Tests for delegated orphan cleanup and timeout visibility smoke. */

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
import { DelegatedOrphanCleanup } from "../../workers/delegated-orphan-cleanup.js";

const parentPolicy = createExecutionPolicy({
  policyId: "parent-policy",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["spawn_subagent", "read_file"],
  deniedTools: [],
  allowedHosts: [],
  deniedHosts: [],
  maxDurationMs: 20_000,
  maxTurnDurationMs: 5_000,
  idleTimeoutMs: 1_000,
  maxIterations: 4,
  maxTokensPerTurn: 4_000,
  credentialScope: "read_only",
});

const parentRuntime: EffectiveDelegationRuntime = {
  profileId: "runner",
  provider: "local-openai",
  model: "qwen",
};

const parentConstraints: DelegationConstraints = {
  maxSpawnDepth: 2,
  maxConcurrentChildren: 4,
};

describe("delegation cleanup and visibility smoke", () => {
  it("kills and archives active children when the parent is released or expires", async () => {
    const eventBus = new FakeEventBus();
    const bridge = new CleanupBridge({
      children: [childView("child-a", "parent-session"), childView("child-b", "parent-session")],
    });
    const cleanup = new DelegatedOrphanCleanup({
      delegationSessions: bridge,
      eventBus,
      logger: new FakeLogger(),
      now: () => 2_000,
    });

    const evidence = await cleanup.cleanupChildrenForParent({
      parentSessionId: "parent-session",
      reason: "parent released",
      initiatedBy: "parent",
    });

    expect(evidence.cleanedChildSessionIds).toEqual(["child-a", "child-b"]);
    expect(bridge.operations).toEqual([
      "list:parent-session",
      "policy:child-a",
      "visibility:delegation.orphan_detected:child-a",
      "kill:child-a:parent released",
      "visibility:delegation.killed:child-a",
      "archive:child-a:parent released",
      "policy:child-b",
      "visibility:delegation.orphan_detected:child-b",
      "kill:child-b:parent released",
      "visibility:delegation.killed:child-b",
      "archive:child-b:parent released",
    ]);
    expect(eventBus.emitted.map((event) => event.event)).toEqual([
      "delegation.orphan_detected",
      "delegation.killed",
      "delegation.orphan_detected",
      "delegation.killed",
    ]);
  });

  it("subscribes to parent session expiry and cleans active delegated children", async () => {
    const eventBus = new FakeEventBus();
    const bridge = new CleanupBridge({
      children: [childView("expiry-child", "parent-session")],
    });
    const cleanup = new DelegatedOrphanCleanup({
      delegationSessions: bridge,
      eventBus,
      logger: new FakeLogger(),
      now: () => 2_000,
    });

    cleanup.activate();
    eventBus.emit({
      event: "session.expired",
      payload: { sessionId: "parent-session", reason: "expired" },
    });
    await flushPromises();

    expect(bridge.operations).toEqual(
      expect.arrayContaining([
        "list:parent-session",
        "kill:expiry-child:expired",
        "archive:expiry-child:expired",
      ]),
    );
    cleanup.deactivate();
  });

  it("returns timeout result and emits structured timeout/kill evidence", async () => {
    const eventBus = new FakeEventBus();
    const bridge = new CleanupBridge();
    const lifecycle = new DelegatedSpawnLifecycle({
      hookRegistry: new InMemoryHookRegistry(new FakeLogger()),
      delegationSessions: bridge,
      eventBus,
      logger: new FakeLogger(),
      childRunner: new HangingRunner(),
      childSessionId: () => "timeout-child",
    });

    const result = await lifecycle.spawn({
      parentSessionId: "parent-session",
      task: "timeout smoke",
      parentPolicy,
      parentDelegationConstraints: parentConstraints,
      parentRuntime,
      allowedRuntimes: [parentRuntime],
      spawnRequest: { task: "timeout smoke", timeoutMs: 0 },
    });

    expect(result.ok && result.value.outcome).toBe("timeout");
    expect(bridge.operations).toEqual(
      expect.arrayContaining(["kill:timeout-child:timeout", "archive:timeout-child:timeout"]),
    );
    expect(eventBus.emitted.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "delegation.spawned",
        "delegation.timeout",
        "delegation.killed",
        "delegation.completed",
      ]),
    );
    expect(bridge.visibility.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["delegation.timeout", "delegation.killed", "delegation.completed"]),
    );
  });

  it("keeps parallel child visibility attributed to distinct sessions and policies", async () => {
    const eventBus = new FakeEventBus();
    let nextId = 0;
    const bridge = new CleanupBridge();
    const lifecycle = new DelegatedSpawnLifecycle({
      hookRegistry: new InMemoryHookRegistry(new FakeLogger()),
      delegationSessions: bridge,
      eventBus,
      logger: new FakeLogger(),
      childRunner: new ImmediateRunner(),
      childSessionId: () => {
        nextId += 1;
        return `parallel-child-${String(nextId)}`;
      },
    });

    const [first, second] = await Promise.all([
      lifecycle.spawn({
        parentSessionId: "parent-session",
        task: "first",
        parentPolicy,
        parentDelegationConstraints: parentConstraints,
        parentRuntime,
        allowedRuntimes: [parentRuntime],
      }),
      lifecycle.spawn({
        parentSessionId: "parent-session",
        task: "second",
        parentPolicy,
        parentDelegationConstraints: parentConstraints,
        parentRuntime,
        allowedRuntimes: [parentRuntime],
      }),
    ]);

    expect(first.ok && first.value.childSessionId).toBe("parallel-child-1");
    expect(second.ok && second.value.childSessionId).toBe("parallel-child-2");
    const completed = eventBus.emitted.filter((event) => event.event === "delegation.completed");
    expect(completed.map((event) => event.payload.childSessionId).sort()).toEqual([
      "parallel-child-1",
      "parallel-child-2",
    ]);
    expect(completed.map((event) => event.payload.policyId).sort()).toEqual([
      "delegated-parallel-child-1",
      "delegated-parallel-child-2",
    ]);
  });
});

class HangingRunner implements DelegatedChildRunner {
  run(_input: DelegatedChildRunInput): Promise<DelegatedResult> {
    void _input;
    return new Promise(() => undefined);
  }
}

class ImmediateRunner implements DelegatedChildRunner {
  async run(input: DelegatedChildRunInput): Promise<DelegatedResult> {
    await input.emitTurnVisible({ turnNumber: 1, phase: "started" });
    return {
      outcome: "success",
      summary: `completed ${input.spawnRequest.task}`,
      policyId: input.policy.policyId,
      childSessionId: input.childSession.sessionId,
      effectiveRuntime: input.effectiveRuntime,
      durationMs: 1,
    };
  }
}

class CleanupBridge implements DelegationSessionBridge {
  readonly operations: string[] = [];
  readonly created: DelegatedSessionCreateRequest[] = [];
  readonly visibility: DelegationVisibilityEvent[] = [];
  readonly #children: readonly ServiceSessionView[];

  constructor(options: { readonly children?: readonly ServiceSessionView[] } = {}) {
    this.#children = options.children ?? [];
  }

  getSession(sessionId: string): Promise<ServiceSessionView | null> {
    this.operations.push(`get:${sessionId}`);
    if (sessionId !== "parent-session") return Promise.resolve(null);
    return Promise.resolve({
      sessionId,
      profileId: "runner",
      kind: "worker",
      state: "active",
      parentSessionId: null,
      rootSessionId: sessionId,
      lastActiveAt: "1970-01-01T00:00:01.000Z",
    });
  }

  createDelegatedSession(request: DelegatedSessionCreateRequest): Promise<ServiceSessionView> {
    this.operations.push(`create:${request.parentSessionId}:${request.profileId}`);
    this.created.push(request);
    const lineage = readLineage(request.visibility);
    const sessionId = lineage?.childSessionId ?? request.sessionId ?? "child";
    return Promise.resolve(childView(sessionId, request.parentSessionId));
  }

  listChildSessions(parentSessionId: string): Promise<readonly ServiceSessionView[]> {
    this.operations.push(`list:${parentSessionId}`);
    return Promise.resolve(this.#children);
  }

  countChildSessions(parentSessionId: string): Promise<number> {
    this.operations.push(`count:${parentSessionId}`);
    return Promise.resolve(this.#children.length);
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

function childView(sessionId: string, parentSessionId: string): ServiceSessionView {
  return {
    sessionId,
    profileId: "runner",
    kind: "delegated",
    state: "active",
    parentSessionId,
    rootSessionId: parentSessionId,
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

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
