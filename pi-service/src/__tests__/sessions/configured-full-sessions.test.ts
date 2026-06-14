/** Tests for configured non-pooled full agent routing. */

import { describe, expect, it } from "vitest";
import { FakeChannelProvider, FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { ChannelContent, ChannelMessage } from "@pi-crew/core";
import { AgentFactoryImpl } from "../../agents/agent-factory.js";
import type { AgentResponder, AgentResponseRequest } from "../../instances/agent-responder.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";
import { DEFAULT_POOL_CONFIG, InstancePoolImpl } from "../../instances/instance-pool.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import { SessionManagerImpl } from "../../sessions/session-manager.js";
import type { ChannelBindingRecord, SessionConfig } from "../../sessions/types.js";

class RecordingResponder implements AgentResponder {
  readonly requests: AgentResponseRequest[] = [];

  respond(request: AgentResponseRequest): Promise<ChannelContent> {
    this.requests.push(request);
    return Promise.resolve({ kind: "text", text: `response from ${request.profileId}` });
  }
}

const runnerBinding: ChannelBindingRecord = {
  providerId: "den-channels",
  channelId: "shared-channel",
  memberIdentity: "pi-crew-runner",
  profileIdentity: "pi-crew-runner",
  memberRole: "runner",
  subscriptionIdentity: "pi-crew-runner:ordinary:sess-runner",
  sessionOwnerId: "owner:runner",
};

const plannerBinding: ChannelBindingRecord = {
  providerId: "den-channels",
  channelId: "shared-channel",
  memberIdentity: "pi-crew-planner",
  profileIdentity: "pi-crew-planner",
  memberRole: "planner",
  subscriptionIdentity: "pi-crew-planner:ordinary:sess-planner",
  sessionOwnerId: "owner:planner",
};

const configuredSessions: readonly SessionConfig[] = [
  {
    sessionId: "sess-runner",
    kind: "full",
    profileId: "runner-profile",
    channelBindings: [runnerBinding],
  },
  {
    sessionId: "sess-planner",
    kind: "full",
    profileId: "planner-profile",
    channelBindings: [plannerBinding],
  },
];

function createHarness() {
  const logger = new FakeLogger();
  const eventBus = new FakeEventBus();
  const store = new InMemorySessionStore();
  const responder = new RecordingResponder();
  const instanceFactory = new InstanceFactoryImpl(logger, { createResponder: () => responder });
  const pool = new InstancePoolImpl(instanceFactory, DEFAULT_POOL_CONFIG, logger);
  const agentFactory = new AgentFactoryImpl(pool, store, eventBus, logger);
  const manager = new SessionManagerImpl(
    store,
    agentFactory,
    pool,
    eventBus,
    logger,
    "fallback-profile",
    null,
  );
  manager.configureFullSessions(configuredSessions);
  return { eventBus, manager, pool, provider: new FakeChannelProvider(), responder, store };
}

function message(id: string, metadata: Record<string, unknown>): ChannelMessage {
  return {
    id,
    channelId: "shared-channel",
    sender: { id: "user", displayName: "User", kind: "human", platform: "test" },
    content: { kind: "text", text: id },
    timestamp: new Date("2026-06-10T00:00:00.000Z"),
    metadata,
  };
}

describe("SessionManagerImpl configured full-agent sessions", () => {
  it("routes two configured agents on one channel by Den member identity", async () => {
    const { manager, provider, responder, store } = createHarness();

    await manager.routeMessage(
      provider,
      message("msg-runner", { memberIdentity: "pi-crew-runner" }),
    );
    await manager.routeMessage(
      provider,
      message("msg-planner", { targetMemberIdentity: "pi-crew-planner" }),
    );

    expect(responder.requests.map((request) => request.profileId)).toEqual([
      "runner-profile",
      "planner-profile",
    ]);
    expect((await store.get("sess-runner"))?.channelBindings).toEqual([runnerBinding]);
    expect((await store.get("sess-planner"))?.channelBindings).toEqual([plannerBinding]);
    expect(provider.sentMessages.map((sent) => sent.content.metadata?.["senderIdentity"])).toEqual([
      "pi-crew-runner",
      "pi-crew-planner",
    ]);
  });

  it("keeps configured agent membership stable while instances stay unshared", async () => {
    const { manager, pool, provider, responder, store } = createHarness();

    await manager.routeMessage(provider, message("msg-1", { sessionId: "sess-runner" }));
    const firstInstance = responder.requests[0]?.instanceId;
    await pool.release(firstInstance ?? "missing");
    const idleRunner = await store.get("sess-runner");
    if (idleRunner !== null) {
      await store.save({ ...idleRunner, instanceId: null, state: "idle" });
    }

    await manager.routeMessage(provider, message("msg-2", { memberIdentity: "pi-crew-runner" }));

    expect(responder.requests[1]?.sessionId).toBe("sess-runner");
    expect(responder.requests[1]?.instanceId).not.toBe(firstInstance);
    expect((await store.get("sess-runner"))?.channelBindings).toEqual([runnerBinding]);
  });

  it("emits configured membership and subscription presence when creating sessions", async () => {
    const { eventBus, manager, provider } = createHarness();

    await manager.routeMessage(
      provider,
      message("msg-planner", {
        subscriptionIdentity: "pi-crew-planner:ordinary:sess-planner",
      }),
    );

    expect(
      eventBus.emitted
        .filter((entry) => entry.event === "session.presence")
        .map((entry) => entry.payload.channelBinding),
    ).toContainEqual(plannerBinding);
  });
});
