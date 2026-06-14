/** Tests for concrete service DelegationSessionBridge. */

import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { createChildDelegationLineage } from "@pi-crew/core";
import { createExecutionPolicy } from "@pi-crew/tools";
import { SessionManagerDelegationSessionBridge } from "../../workers/delegation-session-bridge.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import type { SessionManager } from "../../sessions/session-manager.js";
import type { SessionConfig, SessionRecord } from "../../sessions/types.js";

const policy = createExecutionPolicy({
  policyId: "child-policy",
  rootPath: "/workspace",
  allowedPaths: ["/workspace"],
  denyPaths: [],
  allowedTools: ["read_file"],
  deniedTools: [],
  allowedHosts: [],
  deniedHosts: [],
  maxDurationMs: 1_000,
  maxTurnDurationMs: 500,
  idleTimeoutMs: 250,
  maxIterations: 1,
  maxTokensPerTurn: 1_000,
  credentialScope: "none",
});

describe("SessionManagerDelegationSessionBridge", () => {
  it("creates deterministic delegated sessions and exposes policy/count/cleanup", async () => {
    const store = new InMemorySessionStore();
    const manager = new FakeSessionManager(store);
    await manager.create({ sessionId: "parent", profileId: "parent-profile", kind: "worker" });
    const bus = new FakeEventBus();
    const bridge = new SessionManagerDelegationSessionBridge({
      sessionManager: manager,
      sessionStore: store,
      eventBus: bus,
      logger: new FakeLogger(),
    });
    const lineage = createChildDelegationLineage({
      parentSessionId: "parent",
      childSessionId: "child-1",
    });

    const child = await bridge.createDelegatedSession({
      sessionId: "child-1",
      parentSessionId: "parent",
      profileId: "child-profile",
      policy,
      visibility: { lineage, spawnRequest: { task: "inspect" } },
    });

    expect(child).toEqual(
      expect.objectContaining({
        sessionId: "child-1",
        profileId: "child-profile",
        kind: "delegated",
        parentSessionId: "parent",
        rootSessionId: "parent",
      }),
    );
    expect(await bridge.countChildSessions("parent")).toBe(1);
    expect(await bridge.getParentExecutionPolicy("child-1")).toEqual(policy);

    await bridge.killChildSession("child-1", "test kill");
    expect((await store.get("child-1"))?.state).toBe("active");
    expect(bus.emitted).toHaveLength(0);
    await bridge.releaseChildSession("child-1", "completed");
    expect((await store.get("child-1"))?.state).toBe("idle");
    await bridge.archiveChildSession("child-1", "done");
    expect(await bridge.getSession("child-1")).toBeNull();
    expect(await bridge.getParentExecutionPolicy("child-1")).toBeNull();
  });
});

class FakeSessionManager implements SessionManager {
  constructor(private readonly store: InMemorySessionStore) {}

  async create(config: SessionConfig): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: config.sessionId ?? `session-${String(Date.now())}`,
      profileId: config.profileId,
      instanceId: null,
      kind: config.kind,
      delegation: config.delegation ?? null,
      delegationSpawnRequest: config.delegationSpawnRequest ?? null,
      createdAt: now,
      lastActiveAt: now,
      state: "active",
      messageCount: 0,
      channelBindings: config.channelBindings ?? [],
      workerBinding: config.workerBinding ?? null,
    };
    return this.store.save(record);
  }

  get(sessionId: string): Promise<SessionRecord | null> {
    return this.store.get(sessionId);
  }

  findByChannel(): Promise<SessionRecord | null> {
    return Promise.resolve(null);
  }

  bindChannel(_sessionId: string, _channelId: string): Promise<void> {
    void _sessionId;
    void _channelId;
    return Promise.resolve();
  }

  unbindChannel(_sessionId: string, _channelId: string): Promise<void> {
    void _sessionId;
    void _channelId;
    return Promise.resolve();
  }

  routeMessage(): Promise<void> {
    return Promise.resolve();
  }

  routeDiagnosticMessage(): Promise<void> {
    return Promise.resolve();
  }

  async archive(sessionId: string): Promise<void> {
    const record = await this.store.get(sessionId);
    if (record === null) return;
    await this.store.save({ ...record, state: "archived", instanceId: null });
  }

  evictIdleSessions(): Promise<number> {
    return Promise.resolve(0);
  }
}
