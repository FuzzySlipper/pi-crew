/**
 * Tests for AgentInstance and InstanceFactory.
 *
 * @module pi-service/__tests__/instances/agent-instance.test
 */

import type { ChannelContent, ChannelMessage } from "@pi-crew/core";
import { FakeLogger } from "@pi-crew/core";
import { describe, it, expect, beforeEach } from "vitest";
import { AgentInstanceImpl } from "../../instances/agent-instance.js";
import type {
  AgentResponseRequest,
  AgentResponder,
  AgentResponderFactory,
  AgentResponderFactoryContext,
} from "../../instances/agent-responder.js";
import { EchoAgentResponder } from "../../instances/agent-responder.js";
import {
  ConversationalAgentResponderFactory,
  type ConversationalAgentRuntimeBuilder,
} from "../../instances/conversational-agent-responder.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";

class CapturingAgentResponder implements AgentResponder {
  public readonly requests: AgentResponseRequest[] = [];

  constructor(private readonly response: ChannelContent) {}

  respond(request: AgentResponseRequest): Promise<ChannelContent> {
    this.requests.push(request);
    return Promise.resolve(this.response);
  }
}

class CapturingResponderFactory implements AgentResponderFactory {
  public readonly contexts: AgentResponderFactoryContext[] = [];

  constructor(private readonly responder: AgentResponder) {}

  createResponder(context: AgentResponderFactoryContext): AgentResponder {
    this.contexts.push(context);
    return this.responder;
  }
}

class CapturingRuntimeBuilder implements ConversationalAgentRuntimeBuilder {
  readonly contexts: AgentResponderFactoryContext[] = [];

  build(context: AgentResponderFactoryContext): AgentResponder {
    this.contexts.push(context);
    return new CapturingAgentResponder({
      kind: "text",
      text: "agent-backed-response",
    });
  }
}

function createTextMessage(text: string): ChannelMessage {
  return {
    id: "message-1",
    channelId: "channel-1",
    sender: {
      id: "human-1",
      displayName: "Human One",
      kind: "human",
      platform: "test",
    },
    content: { kind: "text", text },
    timestamp: new Date("2026-06-06T09:32:00.000Z"),
  };
}

describe("AgentInstanceImpl", () => {
  it("creates with a unique id", () => {
    const a = new AgentInstanceImpl("test-profile");
    const b = new AgentInstanceImpl("test-profile");

    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it("stores profileId", () => {
    const instance = new AgentInstanceImpl("spawned-coder");
    expect(instance.profileId).toBe("spawned-coder");
  });

  it("sets createdAt to now", () => {
    const before = new Date();
    const instance = new AgentInstanceImpl("test");
    expect(instance.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("is not disposed initially", () => {
    const instance = new AgentInstanceImpl("test");
    expect(instance.isDisposed).toBe(false);
  });

  it("dispose sets isDisposed to true", async () => {
    const instance = new AgentInstanceImpl("test");
    await instance.dispose();
    expect(instance.isDisposed).toBe(true);
  });

  it("dispose is idempotent", async () => {
    const instance = new AgentInstanceImpl("test");
    await instance.dispose();
    await instance.dispose();
    expect(instance.isDisposed).toBe(true);
  });

  it("accepts a custom id", () => {
    const instance = new AgentInstanceImpl("test", new EchoAgentResponder(), "custom-42");
    expect(instance.id).toBe("custom-42");
  });

  it("delegates message processing to the injected responder", async () => {
    const responder = new CapturingAgentResponder({
      kind: "text",
      text: "custom-response",
    });
    const instance = new AgentInstanceImpl("profile-a", responder);
    const message = createTextMessage("hello");

    const response = await instance.processMessage(message);

    expect(response).toEqual({ kind: "text", text: "custom-response" });
    expect(responder.requests).toHaveLength(1);
    expect(responder.requests[0]).toEqual({
      sessionId: instance.id,
      profileId: "profile-a",
      instanceId: instance.id,
      message,
    });
  });
});

describe("InstanceFactoryImpl", () => {
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
  });

  it("creates an instance from a profile", async () => {
    const factory = new InstanceFactoryImpl(logger);
    const instance = await factory.create("default");

    expect(instance.profileId).toBe("default");
    expect(instance.isDisposed).toBe(false);
  });

  it("logs instance creation", async () => {
    const factory = new InstanceFactoryImpl(logger);
    await factory.create("default");

    const debugLogs = logger.entries.filter((e) => e.level === "debug");
    expect(debugLogs.length).toBeGreaterThanOrEqual(1);
    expect(debugLogs.at(0)?.message).toContain("Creating agent instance");
  });

  it("creates instances with unique ids", async () => {
    const factory = new InstanceFactoryImpl(logger);
    const a = await factory.create("default");
    const b = await factory.create("default");

    expect(a.id).not.toBe(b.id);
  });

  it("defaults to echo-compatible responder behavior", async () => {
    const factory = new InstanceFactoryImpl(logger);
    const instance = await factory.create("default");

    const response = await instance.processMessage(createTextMessage("hello"));

    expect(response).toEqual({ kind: "text", text: "received: hello" });
  });

  it("uses an injected responder factory", async () => {
    const responder = new CapturingAgentResponder({
      kind: "text",
      text: "factory-response",
    });
    const responderFactory = new CapturingResponderFactory(responder);
    const factory = new InstanceFactoryImpl(logger, responderFactory);

    const instance = await factory.create("profile-b", "coder");
    const response = await instance.processMessage(createTextMessage("hello"));

    expect(response).toEqual({ kind: "text", text: "factory-response" });
    expect(responderFactory.contexts).toEqual([{ profileId: "profile-b", role: "coder" }]);
  });

  it("can create instances through the Agent-backed conversational responder factory", async () => {
    const builder = new CapturingRuntimeBuilder();
    const responderFactory = new ConversationalAgentResponderFactory(builder);
    const factory = new InstanceFactoryImpl(logger, responderFactory);

    const instance = await factory.create("system-architect", "runner");
    const response = await instance.processMessage(createTextMessage("hello"));

    expect(response).toEqual({ kind: "text", text: "agent-backed-response" });
    expect(builder.contexts).toEqual([{ profileId: "system-architect", role: "runner" }]);
  });
});
