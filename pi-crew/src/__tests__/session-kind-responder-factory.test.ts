/**
 * Tests for SessionKindAwareResponderFactory.
 *
 * @module pi-crew/__tests__/session-kind-responder-factory.test
 */

import { describe, it, expect } from "vitest";
import type {
  AgentResponder,
  AgentResponderFactory,
  AgentResponderFactoryContext,
} from "@pi-crew/service";
import { EchoAgentResponder } from "@pi-crew/service";
import type { ChannelContent } from "@pi-crew/core";
import { SessionKindAwareResponderFactory } from "../session-kind-responder-factory.js";

/**
 * A responder factory that tracks whether createResponder was called
 * and returns a fixed response.
 */
class TrackingResponderFactory implements AgentResponderFactory {
  public readonly calls: AgentResponderFactoryContext[] = [];

  createResponder(context: AgentResponderFactoryContext): AgentResponder {
    this.calls.push(context);
    return {
      respond: (): Promise<ChannelContent> =>
        Promise.resolve({ kind: "text", text: `conv:${context.profileId}` }),
    };
  }
}

describe("SessionKindAwareResponderFactory", () => {
  it("routes worker sessions to echo responder without calling conversational factory", () => {
    const tracking = new TrackingResponderFactory();
    const factory = new SessionKindAwareResponderFactory(tracking);

    const responder = factory.createResponder({
      profileId: "coder-worker",
      kind: "worker",
    });

    // Should return an EchoAgentResponder (not the tracking factory's responder)
    expect(responder).toBeInstanceOf(EchoAgentResponder);
    expect(tracking.calls).toHaveLength(0);
  });

  it("routes conversational sessions to the conversational factory", () => {
    const tracking = new TrackingResponderFactory();
    const factory = new SessionKindAwareResponderFactory(tracking);

    const responder = factory.createResponder({
      profileId: "conv-architect",
      kind: "conversational",
    });

    // Should delegate to the tracking factory
    expect(tracking.calls).toHaveLength(1);
    expect(tracking.calls[0]?.profileId).toBe("conv-architect");
    expect(tracking.calls[0]?.kind).toBe("conversational");
    // Not an echo responder
    expect(responder).not.toBeInstanceOf(EchoAgentResponder);
  });

  it("routes delegated sessions to echo responder without requiring conversational config match", () => {
    const tracking = new TrackingResponderFactory();
    const factory = new SessionKindAwareResponderFactory(tracking);

    const responder = factory.createResponder({
      profileId: "some-profile",
      kind: "delegated",
    });

    expect(tracking.calls).toHaveLength(0);
    expect(responder).toBeInstanceOf(EchoAgentResponder);
  });

  it("routes sessions with undefined kind to the conversational factory (backward compat)", () => {
    const tracking = new TrackingResponderFactory();
    const factory = new SessionKindAwareResponderFactory(tracking);

    factory.createResponder({
      profileId: "any-profile",
      // kind intentionally omitted
    });

    expect(tracking.calls).toHaveLength(1);
    expect(tracking.calls[0]?.profileId).toBe("any-profile");
    expect(tracking.calls[0]?.kind).toBeUndefined();
  });

  it("echo responder from worker routing actually echoes", async () => {
    const tracking = new TrackingResponderFactory();
    const factory = new SessionKindAwareResponderFactory(tracking);

    const responder = factory.createResponder({
      profileId: "coder-worker",
      kind: "worker",
    });

    const result = await responder.respond({
      sessionId: "test-session",
      profileId: "coder-worker",
      instanceId: "test-instance",
      message: {
        id: "msg-1",
        channelId: "ch-1",
        sender: { id: "sender", displayName: "Sender", kind: "human", platform: "test" },
        content: { kind: "text", text: "hello" },
        timestamp: new Date(),
      },
    });

    expect(result.kind).toBe("text");
    expect((result as { kind: "text"; text: string }).text).toContain("received: hello");
  });
});
