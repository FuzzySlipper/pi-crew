import { describe, expect, it } from "vitest";
import {
  FakeChannelProvider,
  FakeEventBus,
  FakeLogger,
  FakeMembershipChannelProvider,
} from "@pi-crew/core";
import { AgentFactoryImpl } from "../../agents/agent-factory.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";
import { DEFAULT_POOL_CONFIG, InstancePoolImpl } from "../../instances/instance-pool.js";
import { SessionPresenceBridge } from "../../sessions/session-presence-bridge.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import { SessionManagerImpl } from "../../sessions/session-manager.js";
import type { ChannelBindingRecord, SessionConfig } from "../../sessions/types.js";

function binding(overrides: Partial<ChannelBindingRecord> = {}): ChannelBindingRecord {
  return {
    providerId: "den-channels",
    channelId: "ch-alpha",
    memberIdentity: "pi-crew-runner",
    profileIdentity: "pi-crew-runner",
    memberRole: "runner",
    subscriptionIdentity: "pi-crew-runner:ordinary:sess-alpha",
    sessionOwnerId: "owner:den-k8plus:pi-crew-runner",
    ...overrides,
  };
}

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    profileId: "pi-crew-runner",
    kind: "conversational",
    channelBindings: [binding()],
    ...overrides,
  };
}

function message(channelId = "ch-alpha") {
  return {
    id: "msg-1",
    channelId,
    sender: { id: "user-1", displayName: "Tester", kind: "human" as const, platform: "test" },
    content: { kind: "text" as const, text: "hello" },
    timestamp: new Date(),
  };
}

function harness() {
  const logger = new FakeLogger();
  const eventBus = new FakeEventBus();
  const store = new InMemorySessionStore();
  const pool = new InstancePoolImpl(new InstanceFactoryImpl(logger), { ...DEFAULT_POOL_CONFIG, idleTimeoutMs: 0 }, logger);
  const agentFactory = new AgentFactoryImpl(pool, store, eventBus, logger);
  const manager = new SessionManagerImpl(store, agentFactory, pool, eventBus, logger, "fallback-test");
  const presence = new FakeMembershipChannelProvider();
  const bridge = new SessionPresenceBridge(eventBus, presence, logger);
  return { bridge, eventBus, manager, pool, presence, store };
}

describe("SessionPresenceBridge", () => {
  it("refreshes ordinary subscription evidence when a conversational session rehydrates", async () => {
    const { manager, presence, store } = harness();
    const record = await manager.create(config());
    await manager.evictIdleSessions();

    await manager.routeMessage(new FakeChannelProvider(), message());

    const updated = await store.get(record.id);
    const rows = await presence.getPresence({ channelId: "ch-alpha", memberIdentity: "pi-crew-runner" });
    expect(updated?.instanceId).toBeTruthy();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.membershipStatus).toBe("active");
    expect(rows[0]?.presenceState).toBe("active");
    expect(rows[0]?.subscription).toMatchObject({
      agentInstanceId: updated?.instanceId,
      purpose: "ordinary_channel",
      sessionId: record.id,
      subscriptionIdentity: "pi-crew-runner:ordinary:sess-alpha",
    });
    expect(presence.sentMessages).toHaveLength(0);
  });

  it("marks conversational subscriptions idle on idle eviction without leaving membership", async () => {
    const { manager, presence } = harness();
    await manager.create(config());

    await manager.evictIdleSessions();

    const rows = await presence.getPresence({ channelId: "ch-alpha", memberIdentity: "pi-crew-runner" });
    expect(rows[0]?.membershipStatus).toBe("active");
    expect(rows[0]?.presenceState).toBe("idle");
    expect(presence.sentMessages).toHaveLength(0);
  });

  it("marks membership left only when a conversational session is archived", async () => {
    const { manager, presence } = harness();
    const record = await manager.create(config());

    await manager.archive(record.id);

    const rows = await presence.getPresence({ channelId: "ch-alpha", memberIdentity: "pi-crew-runner" });
    expect(rows[0]?.membershipStatus).toBe("left");
    expect(rows[0]?.presenceState).toBe("left");
  });

  it("marks membership left when a conversational session unbinds a channel", async () => {
    const { manager, presence } = harness();
    const record = await manager.create(config());

    await manager.unbindChannel(record.id, "ch-alpha");

    const rows = await presence.getPresence({ channelId: "ch-alpha", memberIdentity: "pi-crew-runner" });
    expect(rows[0]?.membershipStatus).toBe("left");
    expect(rows[0]?.presenceState).toBe("left");
    expect(presence.sentMessages).toHaveLength(0);
  });

  it("does not publish conversational channel presence for worker sessions", async () => {
    const { manager, presence } = harness();
    await manager.create(config({
      kind: "worker",
      channelBindings: [binding()],
      workerBinding: {
        assignmentId: "201",
        runId: "piw_test",
        taskId: "2114",
        projectId: "pi-crew",
        role: "coder",
      },
    }));

    await manager.evictIdleSessions();

    const rows = await presence.getPresence({ channelId: "ch-alpha", memberIdentity: "pi-crew-runner" });
    expect(rows).toHaveLength(0);
  });
});
