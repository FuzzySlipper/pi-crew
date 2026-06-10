/** Tests for durable session ID propagation through conversational routing. */

import type { ChannelContent, ChannelMessage } from "@pi-crew/core";
import { FakeChannelProvider, FakeEventBus, FakeLogger } from "@pi-crew/core";
import { describe, expect, it } from "vitest";
import { AgentFactoryImpl } from "../../agents/agent-factory.js";
import type { AgentResponseRequest, AgentResponder, AgentResponderFactory } from "../../instances/agent-responder.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";
import { DEFAULT_POOL_CONFIG, InstancePoolImpl } from "../../instances/instance-pool.js";
import { SessionManagerImpl } from "../../sessions/session-manager.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";

class CapturingResponder implements AgentResponder {
  readonly requests: AgentResponseRequest[] = [];

  respond(request: AgentResponseRequest): Promise<ChannelContent> {
    this.requests.push(request);
    return Promise.resolve({ kind: "text", text: "ok" });
  }
}

class CapturingResponderFactory implements AgentResponderFactory {
  readonly responder = new CapturingResponder();

  createResponder(): AgentResponder {
    return this.responder;
  }
}

function message(id: string, text: string): ChannelMessage {
  return {
    id,
    channelId: "channel-1",
    sender: { id: "human-1", displayName: "Human", kind: "human", platform: "den-channels" },
    content: { kind: "text", text },
    timestamp: new Date("2026-06-10T00:00:00.000Z"),
  };
}

describe("session history routing", () => {
  it("passes the durable conversational session ID into fresh and rehydrated Agent responders", async () => {
    const logger = new FakeLogger();
    const eventBus = new FakeEventBus();
    const store = new InMemorySessionStore();
    const responderFactory = new CapturingResponderFactory();
    const instanceFactory = new InstanceFactoryImpl(logger, responderFactory);
    const pool = new InstancePoolImpl(instanceFactory, { ...DEFAULT_POOL_CONFIG, idleTimeoutMs: 0 }, logger);
    const agentFactory = new AgentFactoryImpl(pool, store, eventBus, logger);
    const manager = new SessionManagerImpl(store, agentFactory, pool, eventBus, logger, "system-architect");
    const channel = new FakeChannelProvider();

    await manager.routeMessage(channel, message("msg-1", "hello"));
    const record = await store.findByChannel("channel-1");
    const firstRequest = responderFactory.responder.requests.at(0);

    expect(record?.id).toBeTruthy();
    expect(firstRequest?.sessionId).toBe(record?.id);
    expect(firstRequest?.instanceId).not.toBe(record?.id);

    await manager.evictIdleSessions();
    await manager.routeMessage(channel, message("msg-2", "after idle"));
    const secondRequest = responderFactory.responder.requests.at(1);

    expect(secondRequest?.sessionId).toBe(record?.id);
    expect(secondRequest?.instanceId).not.toBe(firstRequest?.instanceId);
  });
});
