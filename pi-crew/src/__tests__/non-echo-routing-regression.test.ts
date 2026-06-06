/**
 * Non-echo routing regression tests with no live network dependency.
 *
 * @module pi-crew/__tests__/non-echo-routing-regression
 */

import { describe, expect, it } from "vitest";

import { DenChannelsAdapter } from "@pi-crew/channels/den-channels/den-channels-adapter";
import { SimulatedDenConnection } from "@pi-crew/channels/den-channels/connection-simulated";
import type { DenInboundMessage } from "@pi-crew/channels/den-channels/connection-types";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import {
  AgentFactoryImpl,
  DeterministicArithmeticTool,
  DeterministicToolAgentResponderFactory,
  InMemorySessionStore,
  InstanceFactoryImpl,
  InstancePoolImpl,
  SessionManagerImpl,
} from "@pi-crew/service";

function makeNonEchoPrompt(): string {
  return "Please reply exactly NON_ECHO_RUNTIME_OK:42 for the arithmetic request 19+23.";
}

function makeInboundMessage(text: string): DenInboundMessage {
  return {
    id: "wake-2035",
    channelId: "604",
    sender: {
      id: "den-system",
      displayName: "Den Channels",
      kind: "system",
    },
    content: { kind: "text", text },
    timestamp: "2026-06-06T10:35:00.000Z",
    metadata: {
      eventKind: "direct-agent-event",
      targetProjectId: "pi-crew",
      targetTaskId: 2035,
      workerRole: "runtime-smoke",
    },
  };
}

function buildHarness(): {
  readonly provider: DenChannelsAdapter;
  readonly connection: SimulatedDenConnection;
  readonly eventBus: FakeEventBus;
} {
  const logger = new FakeLogger();
  const eventBus = new FakeEventBus();
  const connection = new SimulatedDenConnection(logger);
  const provider = new DenChannelsAdapter(connection, logger, {
    name: "Den Channels Gateway",
  });
  const store = new InMemorySessionStore();
  const responderFactory = new DeterministicToolAgentResponderFactory({
    tool: new DeterministicArithmeticTool(),
    eventBus,
  });
  const instanceFactory = new InstanceFactoryImpl(logger, responderFactory);
  const pool = new InstancePoolImpl(
    instanceFactory,
    { maxPerProfile: 4, maxTotal: 16, idleTimeoutMs: 28_800_000 },
    logger,
  );
  const agentFactory = new AgentFactoryImpl(pool, store, eventBus, logger);
  const sessionManager = new SessionManagerImpl(
    store,
    agentFactory,
    pool,
    eventBus,
    logger,
    "system-architect",
  );

  provider.onMessage((message) => {
    return sessionManager.routeMessage(provider, message);
  });

  return { provider, connection, eventBus };
}

async function waitForAsyncRoute(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("non-echo routing regression without live network", () => {
  it("routes the #2020 prompt to a fresh exact NON_ECHO_RUNTIME_OK response", async () => {
    const harness = buildHarness();
    const inboundText = makeNonEchoPrompt();

    await harness.provider.connect();
    harness.connection.simulateInboundMessage(makeInboundMessage(inboundText));
    await waitForAsyncRoute();
    await harness.provider.disconnect();

    expect(harness.connection.sentMessages).toHaveLength(1);
    const sent = harness.connection.sentMessages[0];
    expect(sent?.channelId).toBe("604");
    expect(sent?.payload.content).toEqual({
      kind: "text",
      text: "NON_ECHO_RUNTIME_OK:42",
    });
    expect(sent?.payload.content).not.toEqual({ kind: "text", text: inboundText });
  });

  it("emits deterministic tool lifecycle events for the routed response", async () => {
    const harness = buildHarness();

    await harness.provider.connect();
    harness.connection.simulateInboundMessage(makeInboundMessage(makeNonEchoPrompt()));
    await waitForAsyncRoute();
    await harness.provider.disconnect();

    const called = harness.eventBus.emitted.find(
      (event) => event.event === "tool.called",
    );
    expect(called?.event).toBe("tool.called");
    if (called?.event !== "tool.called") {
      expect.fail("Expected routed deterministic call to emit tool.called");
    }
    expect(called.payload.params).toEqual({ left: 19, right: 23 });

    const completed = harness.eventBus.emitted.find(
      (event) => event.event === "tool.completed",
    );
    expect(completed?.event).toBe("tool.completed");
    if (completed?.event !== "tool.completed") {
      expect.fail("Expected routed deterministic call to emit tool.completed");
    }
    expect(completed.payload.result).toEqual({
      sum: 42,
      responseText: "NON_ECHO_RUNTIME_OK:42",
    });
  });

  it("falls back to echo routing without deterministic tool events for non-matching prompts", async () => {
    const harness = buildHarness();
    const fallbackText = "Please acknowledge this ordinary runtime message.";

    await harness.provider.connect();
    harness.connection.simulateInboundMessage(makeInboundMessage(fallbackText));
    await waitForAsyncRoute();
    await harness.provider.disconnect();

    expect(harness.connection.sentMessages).toHaveLength(1);
    const sent = harness.connection.sentMessages[0];
    expect(sent?.channelId).toBe("604");
    expect(sent?.payload.content).toEqual({
      kind: "text",
      text: `received: ${fallbackText}`,
    });
    expect(
      harness.eventBus.emitted.some((event) => event.event === "tool.called"),
    ).toBe(false);
    expect(
      harness.eventBus.emitted.some((event) => event.event === "tool.completed"),
    ).toBe(false);
  });
});
