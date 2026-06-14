import { describe, expect, it } from "vitest";
import { FakeChannelProvider, FakeEventBus, FakeLogger, type EventPayload } from "@pi-crew/core";
import { AgentFactoryImpl } from "../../agents/agent-factory.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";
import { DEFAULT_POOL_CONFIG, InstancePoolImpl } from "../../instances/instance-pool.js";
import { SessionManagerImpl } from "../../sessions/session-manager.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import type { ChannelBinding } from "../../sessions/types.js";

function managerHarness() {
  const logger = new FakeLogger();
  const eventBus = new FakeEventBus();
  const store = new InMemorySessionStore();
  const pool = new InstancePoolImpl(new InstanceFactoryImpl(logger), DEFAULT_POOL_CONFIG, logger);
  const factory = new AgentFactoryImpl(pool, store, eventBus, logger);
  const bindingFor = (channelId: string): ChannelBinding => ({
    providerId: "den-channels",
    channelId,
    memberIdentity: "pi-crew-runner",
    profileIdentity: "pi-crew-runner",
    memberRole: "runner",
    subscriptionIdentity: `pi-crew-runner:ordinary:${channelId}`,
    sessionOwnerId: "owner:pi-crew-runner",
  });
  const manager = new SessionManagerImpl(
    store,
    factory,
    pool,
    eventBus,
    logger,
    "fallback-test",
    bindingFor,
  );
  return { eventBus, manager, store };
}

function presencePayloads(eventBus: FakeEventBus): EventPayload<"session.presence">[] {
  return eventBus.emitted
    .filter((entry) => entry.event === "session.presence")
    .map((entry) => entry.payload);
}

describe("SessionManagerImpl presence binding lifecycle", () => {
  it("creates fallback routed sessions with typed channel binding metadata", async () => {
    const { eventBus, manager, store } = managerHarness();

    await manager.routeMessage(new FakeChannelProvider(), {
      id: "msg-1",
      channelId: "642",
      sender: { id: "human-1", displayName: "Human", kind: "human", platform: "den" },
      content: { kind: "text", text: "hello" },
      timestamp: new Date(),
    });

    const record = await store.findByChannel("642");
    expect(record?.channelBindings[0]).toMatchObject({
      providerId: "den-channels",
      channelId: "642",
      memberIdentity: "pi-crew-runner",
      subscriptionIdentity: "pi-crew-runner:ordinary:642",
    });
    expect(presencePayloads(eventBus).some((payload) => payload.reason === "created"
      && payload.channelBinding.subscriptionIdentity === "pi-crew-runner:ordinary:642")).toBe(true);
  });

  it("emits presence events when fullAgent channels are bound and unbound", async () => {
    const { eventBus, manager } = managerHarness();
    const record = await manager.create({ profileId: "fallback-test", kind: "full" });
    eventBus.clear();

    await manager.bindChannel(record.id, "642");
    await manager.unbindChannel(record.id, "642");

    const payloads = presencePayloads(eventBus);
    expect(payloads.map((payload) => payload.reason)).toEqual(["bound", "unbound"]);
    const unbound = payloads.find((payload) => payload.reason === "unbound");
    expect(unbound?.subscriptionStatus).toBe("offline");
    expect(unbound?.membershipStatus).toBe("left");
  });
});
