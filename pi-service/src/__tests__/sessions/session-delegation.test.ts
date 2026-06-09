import { describe, expect, it } from "vitest";
import { FakeEventBus } from "@pi-crew/core";
import { createChildDelegationLineage } from "@pi-crew/core";
import { AgentFactoryImpl } from "../../agents/agent-factory.js";
import { AgentInstanceImpl, type AgentInstance } from "../../instances/agent-instance.js";
import type { InstancePool } from "../../instances/instance-pool.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import type { SessionConfig, SessionRecord } from "../../sessions/types.js";
import { FakeLogger } from "@pi-crew/core";

class FakePool implements InstancePool {
  private readonly instances = new Map<string, AgentInstance>();

  get size(): number {
    return this.instances.size;
  }

  acquire(profileId: string): Promise<AgentInstance> {
    const instance = new AgentInstanceImpl(profileId, undefined, `instance-${profileId}`);
    this.instances.set(instance.id, instance);
    return Promise.resolve(instance);
  }

  release(instanceId: string): Promise<void> {
    this.instances.delete(instanceId);
    return Promise.resolve();
  }

  evictIdle(): Promise<number> {
    return Promise.resolve(0);
  }

  touch(instanceId: string): void {
    void instanceId;
    // no-op fake
  }

  has(instanceId: string): boolean {
    return this.instances.has(instanceId);
  }

  get(instanceId: string): AgentInstance | undefined {
    return this.instances.get(instanceId);
  }
}

describe("delegated session lineage", () => {
  it("keeps existing conversational sessions structurally compatible", async () => {
    const store = new InMemorySessionStore();
    await store.save(baseRecord({ id: "conversation", kind: "conversational" }));

    const saved = await store.get("conversation");

    expect(saved?.delegation).toBeNull();
    expect(saved?.delegationSpawnRequest).toBeNull();
  });

  it("stores delegated session lineage and spawn request", async () => {
    const store = new InMemorySessionStore();
    const lineage = createChildDelegationLineage({
      childSessionId: "child-session",
      parentSessionId: "parent-session",
    });
    const record = baseRecord({
      id: "child-session",
      kind: "delegated",
      delegation: lineage,
      delegationSpawnRequest: {
        task: "review implementation",
        modelSelection: { profileId: "reviewer-child", model: "claude-sonnet" },
      },
    });

    await store.save(record);
    const saved = await store.get("child-session");

    expect(saved?.kind).toBe("delegated");
    expect(saved?.delegation?.parentSessionId).toBe("parent-session");
    expect(saved?.delegationSpawnRequest?.modelSelection?.profileId).toBe("reviewer-child");
  });

  it("creates delegated sessions through AgentFactory", async () => {
    const store = new InMemorySessionStore();
    const eventBus = new FakeEventBus();
    const factory = new AgentFactoryImpl(
      new FakePool(),
      store,
      eventBus,
      new FakeLogger(),
    );
    const config: SessionConfig = {
      kind: "delegated",
      profileId: "child-profile",
      delegation: createChildDelegationLineage({
        childSessionId: "pending-child",
        parentSessionId: "parent-session",
      }),
      delegationSpawnRequest: { task: "inspect focused files" },
    };

    const created = await factory.createSession(config);

    expect(created.kind).toBe("delegated");
    expect(created.channelBindings).toEqual([]);
    expect(created.workerBinding).toBeNull();
    expect(created.delegation?.rootSessionId).toBe("parent-session");
    expect(created.delegationSpawnRequest?.task).toBe("inspect focused files");
  });
});

function baseRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    channelBindings: [],
    createdAt: "2026-06-09T00:00:00.000Z",
    delegation: null,
    delegationSpawnRequest: null,
    id: "session",
    instanceId: "instance",
    kind: "conversational",
    lastActiveAt: "2026-06-09T00:00:00.000Z",
    messageCount: 0,
    profileId: "profile",
    state: "active",
    workerBinding: null,
    ...overrides,
  };
}
