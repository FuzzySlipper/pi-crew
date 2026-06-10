/**
 * Tests for deterministic tool-backed agent responder.
 *
 * @module pi-service/__tests__/instances/deterministic-tool-responder.test
 */

import { ConfigurationError, FakeEventBus } from "@pi-crew/core";
import { describe, expect, it } from "vitest";
import {
  DeterministicArithmeticTool,
  DeterministicToolAgentResponder,
  DeterministicToolAgentResponderFactory,
} from "../../instances/deterministic-tool-responder.js";
import type { AgentResponderFactoryContext } from "../../instances/agent-responder.js";
import { EchoAgentResponder } from "../../instances/agent-responder.js";
import { AgentInstanceImpl } from "../../instances/agent-instance.js";
import type { ChannelMessage } from "@pi-crew/core";

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
    timestamp: new Date("2026-06-06T10:00:00.000Z"),
  };
}

describe("DeterministicToolAgentResponder", () => {
  it("uses the deterministic arithmetic tool for the #2020 non-echo scenario", async () => {
    const responder = new DeterministicToolAgentResponder({
      tool: new DeterministicArithmeticTool(),
      fallback: new EchoAgentResponder(),
    });
    const prompt =
      "Please reply exactly NON_ECHO_RUNTIME_OK:42 for the arithmetic request 19+23.";

    const response = await responder.respond({
      sessionId: "sess-test",
      profileId: "pi-crew-gateway",
      instanceId: "instance-1",
      message: createTextMessage(prompt),
    });

    expect(response).toEqual({ kind: "text", text: "NON_ECHO_RUNTIME_OK:42" });
    expect(response.kind).toBe("text");
    if (response.kind === "text") {
      expect(response.text).not.toContain("received:");
      expect(response.text).not.toContain(prompt);
    }
  });

  it("falls back to exact echo behavior for unsupported text", async () => {
    const responder = new DeterministicToolAgentResponder({
      tool: new DeterministicArithmeticTool(),
      fallback: new EchoAgentResponder(),
    });

    const response = await responder.respond({
      sessionId: "sess-test",
      profileId: "pi-crew-gateway",
      instanceId: "instance-1",
      message: createTextMessage("hello world"),
    });

    expect(response).toEqual({ kind: "text", text: "received: hello world" });
  });

  it("emits tool lifecycle events for matching deterministic calls", async () => {
    const eventBus = new FakeEventBus();
    const responder = new DeterministicToolAgentResponder({
      tool: new DeterministicArithmeticTool(),
      fallback: new EchoAgentResponder(),
      eventBus,
    });

    await responder.respond({
      sessionId: "sess-test",
      profileId: "pi-crew-gateway",
      instanceId: "instance-1",
      message: createTextMessage("Return NON_ECHO_RUNTIME_OK for 19+23."),
    });

    expect(eventBus.emitted).toHaveLength(2);
    expect(eventBus.emitted[0]).toEqual({
      event: "tool.called",
      payload: {
        toolName: "deterministic_arithmetic_sum",
        sessionId: "instance-1",
        params: { left: 19, right: 23 },
      },
    });
    const completed = eventBus.emitted[1];
    expect(completed?.event).toBe("tool.completed");
    if (completed?.event !== "tool.completed") {
      expect.fail("Expected tool.completed event");
    }
    expect(completed.payload.toolName).toBe("deterministic_arithmetic_sum");
    expect(completed.payload.sessionId).toBe("instance-1");
    expect(completed.payload.success).toBe(true);
    expect(completed.payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.payload.result).toEqual({
      sum: 42,
      responseText: "NON_ECHO_RUNTIME_OK:42",
    });
  });

  it("does not emit tool lifecycle events for fallback responses", async () => {
    const eventBus = new FakeEventBus();
    const responder = new DeterministicToolAgentResponder({
      tool: new DeterministicArithmeticTool(),
      fallback: new EchoAgentResponder(),
      eventBus,
    });

    await responder.respond({
      sessionId: "sess-test",
      profileId: "pi-crew-gateway",
      instanceId: "instance-1",
      message: createTextMessage("hello world"),
    });

    expect(eventBus.emitted).toEqual([]);
  });
});

describe("DeterministicToolAgentResponderFactory", () => {
  it("creates responders that can be injected into AgentInstanceImpl", async () => {
    const factory = new DeterministicToolAgentResponderFactory({
      tool: new DeterministicArithmeticTool(),
    });
    const context: AgentResponderFactoryContext = {
      profileId: "pi-crew-gateway",
      role: "gateway",
    };
    const instance = new AgentInstanceImpl(
      "pi-crew-gateway",
      factory.createResponder(context),
      "instance-1",
    );

    const response = await instance.processMessage(
      createTextMessage("Use NON_ECHO_RUNTIME_OK for 19+23."),
    );

    expect(response).toEqual({ kind: "text", text: "NON_ECHO_RUNTIME_OK:42" });
  });

  it("fails closed when deterministic runtime is selected without the required tool", () => {
    const factory = new DeterministicToolAgentResponderFactory({});

    expect(() =>
      factory.createResponder({ profileId: "pi-crew-gateway" }),
    ).toThrow(ConfigurationError);
  });
});
