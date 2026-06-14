/** Tests for fullAgent turn coordination and safe failures. */

import { describe, expect, it } from "vitest";
import { FakeChannelProvider, FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { ChannelContent, ChannelMessage } from "@pi-crew/core";
import { AgentFactoryImpl } from "../../agents/agent-factory.js";
import type { AgentResponder, AgentResponseRequest } from "../../instances/agent-responder.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";
import { DEFAULT_POOL_CONFIG, InstancePoolImpl } from "../../instances/instance-pool.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import { SessionManagerImpl } from "../../sessions/session-manager.js";
import type { ChannelBindingRecord } from "../../sessions/types.js";

interface DeferredResponse {
  readonly promise: Promise<ChannelContent>;
  readonly resolve: (content: ChannelContent) => void;
  readonly reject: (error: unknown) => void;
}

class ControlledResponder implements AgentResponder {
  readonly requests: AgentResponseRequest[] = [];
  readonly deferred: DeferredResponse[] = [];

  respond(request: AgentResponseRequest): Promise<ChannelContent> {
    this.requests.push(request);
    const deferred = createDeferredResponse();
    this.deferred.push(deferred);
    return deferred.promise;
  }
}

const binding: ChannelBindingRecord = {
  providerId: "den-channels",
  channelId: "ch-turns",
  memberIdentity: "pi-crew-runner",
  profileIdentity: "pi-crew-runner",
  memberRole: "runner",
  subscriptionIdentity: "pi-crew-runner:ordinary:sess-turns",
  sessionOwnerId: "owner:test",
};

function createHarness(options: { readonly turnTimeoutMs?: number } = {}) {
  const logger = new FakeLogger();
  const eventBus = new FakeEventBus();
  const store = new InMemorySessionStore();
  const responder = new ControlledResponder();
  const instanceFactory = new InstanceFactoryImpl(logger, {
    createResponder: () => responder,
  });
  const pool = new InstancePoolImpl(instanceFactory, DEFAULT_POOL_CONFIG, logger);
  const agentFactory = new AgentFactoryImpl(pool, store, eventBus, logger);
  const manager = new SessionManagerImpl(
    store,
    agentFactory,
    pool,
    eventBus,
    logger,
    "system-architect",
    () => binding,
    options,
  );
  return { eventBus, manager, provider: new FakeChannelProvider(), responder };
}

function message(id: string, text: string): ChannelMessage {
  return {
    id,
    channelId: "ch-turns",
    sender: { id: "user", displayName: "User", kind: "human", platform: "test" },
    content: { kind: "text", text },
    timestamp: new Date("2026-06-10T00:00:00.000Z"),
  };
}

describe("SessionManagerImpl fullAgent turn coordination", () => {
  it("serializes concurrent messages for one session and emits busy then active presence", async () => {
    const { eventBus, manager, provider, responder } = createHarness();
    await manager.create({
      kind: "full",
      profileId: "system-architect",
      channelBindings: [binding],
    });
    eventBus.clear();

    const first = manager.routeMessage(provider, message("msg-1", "first"));
    await waitFor(() => responder.requests.length === 1);
    const second = manager.routeMessage(provider, message("msg-2", "second"));
    await Promise.resolve();

    expect(responder.requests.map((request) => request.message.id)).toEqual(["msg-1"]);
    responder.deferred[0]?.resolve({ kind: "text", text: "first done" });
    await waitFor(() => responder.requests.length === 2);
    expect(provider.sentMessages.map((sent) => textOf(sent.content))).toEqual(["first done"]);
    responder.deferred[1]?.resolve({ kind: "text", text: "second done" });
    await Promise.all([first, second]);

    expect(provider.sentMessages.map((sent) => textOf(sent.content))).toEqual([
      "first done",
      "second done",
    ]);
    expect(
      eventBus.emitted
        .filter((entry) => entry.event === "session.presence")
        .map((entry) => entry.payload.subscriptionStatus),
    ).toContain("busy");
    expect(
      eventBus.emitted.filter((entry) => entry.event === "session.presence").at(-1)?.payload
        .subscriptionStatus,
    ).toBe("active");
  });

  it("sends a safe response and recovers presence after provider failure", async () => {
    const { eventBus, manager, provider, responder } = createHarness();
    await manager.create({
      kind: "full",
      profileId: "system-architect",
      channelBindings: [binding],
    });
    eventBus.clear();

    const routed = manager.routeMessage(provider, message("msg-1", "fail"));
    await waitFor(() => responder.requests.length === 1);
    responder.deferred[0]?.reject(new Error("provider secret stack trace"));
    await routed;

    expect(textOf(provider.sentMessages[0]?.content)).toBe(
      "The agent hit an internal error while responding. Please try again.",
    );
    expect(textOf(provider.sentMessages[0]?.content)).not.toContain("provider secret");
    expect(
      eventBus.emitted
        .filter((entry) => entry.event === "session.presence")
        .map((entry) => entry.payload.subscriptionStatus)
        .slice(-3),
    ).toEqual(["busy", "degraded", "active"]);
  });

  it("times out a stuck turn with a safe response and releases the session lock", async () => {
    const { manager, provider, responder } = createHarness({ turnTimeoutMs: 5 });
    await manager.create({
      kind: "full",
      profileId: "system-architect",
      channelBindings: [binding],
    });

    await manager.routeMessage(provider, message("msg-1", "timeout"));
    const timedOutInstanceId = responder.requests.at(0)?.instanceId;
    const second = manager.routeMessage(provider, message("msg-2", "after timeout"));
    await waitFor(() => responder.requests.length === 2);
    expect(responder.requests.at(1)?.instanceId).not.toBe(timedOutInstanceId);
    responder.deferred[1]?.resolve({ kind: "text", text: "recovered" });
    await second;
    responder.deferred[0]?.resolve({ kind: "text", text: "late stale response" });
    await Promise.resolve();

    expect(provider.sentMessages.map((sent) => textOf(sent.content))).toEqual([
      "The agent timed out while responding. Please try again.",
      "recovered",
    ]);
  });
});

function createDeferredResponse(): DeferredResponse {
  let resolve!: (content: ChannelContent) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ChannelContent>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function textOf(content: ChannelContent | undefined): string | undefined {
  return content?.kind === "text" ? content.text : undefined;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}
