import type { ChannelContent } from "@pi-crew/core";
import { FakeChannelProvider, FakeEventBus, FakeLogger } from "@pi-crew/core";
import { describe, expect, it } from "vitest";
import { AgentFactoryImpl } from "../../agents/agent-factory.js";
import type { AgentResponder, AgentResponderFactory } from "../../instances/agent-responder.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";
import { DEFAULT_POOL_CONFIG, InstancePoolImpl } from "../../instances/instance-pool.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import { SessionManagerImpl } from "../../sessions/session-manager.js";
import type { SessionConfig } from "../../sessions/types.js";

function makeSessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return { profileId: "default", kind: "full", ...overrides };
}

function makeMessage(id: string, channelId = "ch-alpha", metadata: Record<string, unknown> = {}) {
  return {
    id,
    channelId,
    sender: { id: "user-1", displayName: "Tester", kind: "human" as const, platform: "test" },
    content: { kind: "text" as const, text: "hello" },
    timestamp: new Date(),
    metadata,
  };
}

function textContent(content: ChannelContent): string {
  return content.kind === "text" ? content.text : "";
}

class DeferredResponse {
  readonly promise: Promise<ChannelContent>;
  #resolve: ((value: ChannelContent) => void) | undefined;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  resolve(text: string): void {
    this.#resolve?.({ kind: "text", text });
  }
}

class SequencedResponderFactory implements AgentResponderFactory {
  readonly deferred = new DeferredResponse();
  callCount = 0;

  createResponder(): AgentResponder {
    return {
      respond: () => {
        this.callCount += 1;
        if (this.callCount === 1) return this.deferred.promise;
        return Promise.resolve({ kind: "text", text: `response-${String(this.callCount)}` });
      },
    };
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("SessionManagerImpl full-agent response timeout", () => {
  it("keeps a timed-out full-agent session active and non-reentrant until the run settles", async () => {
    const responderFactory = new SequencedResponderFactory();
    const logger = new FakeLogger();
    const eventBus = new FakeEventBus();
    const store = new InMemorySessionStore();
    const pool = new InstancePoolImpl(new InstanceFactoryImpl(logger, responderFactory), DEFAULT_POOL_CONFIG, logger);
    const manager = new SessionManagerImpl(
      store,
      new AgentFactoryImpl(pool, store, eventBus, logger),
      pool,
      eventBus,
      logger,
      "fallback-test",
      null,
      { turnTimeoutMs: 10 },
    );
    const record = await manager.create(makeSessionConfig({ channelBindings: ["ch-alpha"], responseTimeoutMs: 10 }));
    const provider = new FakeChannelProvider();

    const firstRoute = manager.routeMessage(provider, makeMessage("msg-timeout"));
    await wait(30);

    const firstSent = provider.sentMessages.at(0);
    expect(firstSent).toBeDefined();
    expect(textContent(firstSent?.content ?? { kind: "text", text: "" })).toContain("session remains busy");
    expect(await store.get(record.id)).toMatchObject({ state: "active", instanceId: record.instanceId });
    expect(pool.has(record.instanceId ?? "")).toBe(true);
    expect(eventBus.emitted.find((event) => event.event === "session.response_timeout")?.payload).toMatchObject({
      sessionId: record.id,
      timeoutMs: 10,
      phase: "timed_out",
      stillSettling: true,
    });

    const secondRoute = manager.routeMessage(provider, makeMessage("msg-second"));
    await wait(30);
    expect(responderFactory.callCount).toBe(1);

    responderFactory.deferred.resolve("late first response");
    await firstRoute;
    await secondRoute;

    expect(responderFactory.callCount).toBe(2);
    expect(provider.sentMessages.map((sent) => textContent(sent.content))).toEqual([
      expect.stringContaining("session remains busy"),
      "response-2",
    ]);
    const settledEvent = eventBus.emitted.find(
      (event) => event.event === "session.response_timeout" && event.payload.phase === "settled",
    );
    expect(settledEvent?.payload).toMatchObject({ stillSettling: false });
  });

  it("uses configured full-agent lifecycle timeout for configured sessions", async () => {
    const responderFactory = new SequencedResponderFactory();
    const logger = new FakeLogger();
    const eventBus = new FakeEventBus();
    const store = new InMemorySessionStore();
    const pool = new InstancePoolImpl(new InstanceFactoryImpl(logger, responderFactory), DEFAULT_POOL_CONFIG, logger);
    const manager = new SessionManagerImpl(store, new AgentFactoryImpl(pool, store, eventBus, logger), pool, eventBus, logger, "fallback-test", null, { turnTimeoutMs: 60_000 });
    manager.configureFullSessions([
      makeSessionConfig({ sessionId: "sess-configured", channelBindings: ["ch-alpha"], responseTimeoutMs: 10 }),
    ]);
    const provider = new FakeChannelProvider();

    const route = manager.routeMessage(provider, makeMessage("msg-configured", "ch-alpha", { sessionId: "sess-configured" }));
    await wait(30);

    expect(provider.sentMessages).toHaveLength(1);
    expect(eventBus.emitted.find((event) => event.event === "session.response_timeout")?.payload).toMatchObject({
      sessionId: "sess-configured",
      timeoutMs: 10,
      phase: "timed_out",
    });
    responderFactory.deferred.resolve("settled");
    await route;
  });

  it("allows configured full-agent response timeouts to be disabled", async () => {
    const responderFactory = new SequencedResponderFactory();
    const logger = new FakeLogger();
    const eventBus = new FakeEventBus();
    const store = new InMemorySessionStore();
    const pool = new InstancePoolImpl(new InstanceFactoryImpl(logger, responderFactory), DEFAULT_POOL_CONFIG, logger);
    const manager = new SessionManagerImpl(
      store,
      new AgentFactoryImpl(pool, store, eventBus, logger),
      pool,
      eventBus,
      logger,
      "fallback-test",
      null,
      { turnTimeoutMs: 10 },
    );
    manager.configureFullSessions([
      makeSessionConfig({ sessionId: "sess-disabled", channelBindings: ["ch-alpha"], responseTimeoutMs: null }),
    ]);
    const provider = new FakeChannelProvider();

    const route = manager.routeMessage(provider, makeMessage("msg-disabled", "ch-alpha", { sessionId: "sess-disabled" }));
    await wait(30);

    expect(provider.sentMessages).toHaveLength(0);
    expect(eventBus.emitted.some((event) => event.event === "session.response_timeout")).toBe(false);

    responderFactory.deferred.resolve("eventually ok");
    await route;

    expect(provider.sentMessages.map((sent) => textContent(sent.content))).toEqual(["eventually ok"]);
  });
});
