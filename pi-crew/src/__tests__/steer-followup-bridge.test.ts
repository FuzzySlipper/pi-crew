/**
 * Unit tests for SteerFollowUpBridge.
 *
 * Verifies the steer/followUp ingress bridge routes direct-agent events
 * with intent metadata to the correct active Agent.
 *
 * Covers:
 * - steer intent routes to agent.steer()
 * - follow_up intent routes to agent.followUp()
 * - unknown/absent intent falls through (returns false)
 * - no matching agent logs warning and returns false
 * - AgentMessage is constructed from body text
 * - lookup by runId and assignmentId
 *
 * @module pi-crew/__tests__/steer-followup-bridge.test
 */

import { describe, it, expect, vi } from "vitest";

import { FakeLogger } from "@pi-crew/core";
import type { ChannelMessage, ChannelParticipant, ChannelContent } from "@pi-crew/core";

import {
  SteerFollowUpBridge,
} from "../steer-followup-bridge.js";

import { AgentRuntimeRegistry } from "@pi-crew/service";
import type { SteerableAgent, AgentSupervisor } from "@pi-crew/service";

// ── Helpers ──────────────────────────────────────────────────────

function makeChannelMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  const sender: ChannelParticipant = {
    id: "test-sender",
    displayName: "Test Sender",
    kind: "agent",
    platform: "den-channels",
  };
  const content: ChannelContent = { kind: "text", text: "steer this way" };
  return {
    id: "msg-1",
    channelId: "ch-1",
    sender,
    content,
    timestamp: new Date(),
    ...overrides,
  };
}

function makeSteerableAgent(): SteerableAgent {
  return {
    subscribe: vi.fn(() => () => {}),
    steer: vi.fn(),
    followUp: vi.fn(),
    hasQueuedMessages: vi.fn(() => false),
  };
}

function makeSupervisor(isActive = true): AgentSupervisor {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isActive,
    turnCount: 0,
    tokensUsed: 0,
    tokenTracker: undefined,
  } as unknown as AgentSupervisor;
}

// ── Tests ────────────────────────────────────────────────────────

describe("SteerFollowUpBridge", () => {
  it("returns false for messages without steer/follow_up intent", () => {
    const registry = new AgentRuntimeRegistry();
    const logger = new FakeLogger();
    const bridge = new SteerFollowUpBridge(registry, logger);

    const msg = makeChannelMessage();
    const result = bridge.route(msg);
    expect(result).toBe(false);
  });

  it("routes steer intent to agent.steer() by runId", () => {
    const registry = new AgentRuntimeRegistry();
    const logger = new FakeLogger();
    const agent = makeSteerableAgent();
    const supervisor = makeSupervisor();

    registry.register("run-123", "assign-456", { agent, supervisor });

    const bridge = new SteerFollowUpBridge(registry, logger);

    const msg = makeChannelMessage({
      content: { kind: "text", text: "please change approach" },
      metadata: {
        intent: "steer",
        workerRunId: "run-123",
      },
    });

    const result = bridge.route(msg);
    expect(result).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(agent.steer)).toHaveBeenCalledTimes(1);

    // Verify the AgentMessage was constructed with the body text
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const steerCalls = vi.mocked(agent.steer).mock.calls;
    const callArg = steerCalls[0];
    expect(callArg).toBeDefined();
    const steerMsg = callArg?.[0];
    expect((steerMsg as Record<string, unknown> | undefined)?.role).toBe("user");
    expect((steerMsg as Record<string, unknown> | undefined)?.content).toBe("please change approach");
  });

  it("routes follow_up intent to agent.followUp() by assignmentId", () => {
    const registry = new AgentRuntimeRegistry();
    const logger = new FakeLogger();
    const agent = makeSteerableAgent();
    const supervisor = makeSupervisor();

    registry.register("run-789", "assign-456", { agent, supervisor });

    const bridge = new SteerFollowUpBridge(registry, logger);

    const msg = makeChannelMessage({
      content: { kind: "text", text: "review feedback incorporated" },
      metadata: {
        intent: "follow_up",
        assignmentId: "assign-456",
      },
    });

    const result = bridge.route(msg);
    expect(result).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(agent.followUp)).toHaveBeenCalledTimes(1);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const followUpCalls = vi.mocked(agent.followUp).mock.calls;
    const fuCallArg = followUpCalls[0];
    expect(fuCallArg).toBeDefined();
    const fuMsg = fuCallArg?.[0];
    expect((fuMsg as Record<string, unknown> | undefined)?.role).toBe("user");
    expect((fuMsg as Record<string, unknown> | undefined)?.content).toBe("review feedback incorporated");
  });

  it("handles with warn/no-op when no agent matches runId", () => {
    const registry = new AgentRuntimeRegistry();
    const logger = new FakeLogger();
    const bridge = new SteerFollowUpBridge(registry, logger);

    const msg = makeChannelMessage({
      metadata: {
        intent: "steer",
        workerRunId: "nonexistent",
      },
    });

    const result = bridge.route(msg);
    expect(result).toBe(true);

    // Should have logged a warning
    const warnEntries = logger.entries.filter((e) => e.message.includes("no active Agent"));
    expect(warnEntries.length).toBe(1);
    const ctx = warnEntries[0]?.context as { workerRunId: string } | undefined;
    expect(ctx?.workerRunId).toBe("nonexistent");
  });

  it("handles with warn/no-op when metadata has no runId or assignmentId", () => {
    const registry = new AgentRuntimeRegistry();
    const logger = new FakeLogger();
    const bridge = new SteerFollowUpBridge(registry, logger);

    const msg = makeChannelMessage({
      metadata: {
        intent: "steer",
        // no runId or assignmentId
      },
    });

    const result = bridge.route(msg);
    expect(result).toBe(true);

    const warnEntries = logger.entries.filter(
      (e) => e.message.includes("missing runId or assignmentId"),
    );
    expect(warnEntries.length).toBe(1);
  });

  it("falls through for unknown intent values", () => {
    const registry = new AgentRuntimeRegistry();
    const logger = new FakeLogger();
    const bridge = new SteerFollowUpBridge(registry, logger);

    const msg = makeChannelMessage({
      metadata: {
        intent: "unknown_intent",
        workerRunId: "run-123",
      },
    });

    const result = bridge.route(msg);
    expect(result).toBe(false);
  });

  it("handles with warn/no-op when the target supervisor is inactive", () => {
    const registry = new AgentRuntimeRegistry();
    const logger = new FakeLogger();
    const agent = makeSteerableAgent();
    registry.register("run-123", "assign-456", {
      agent,
      supervisor: makeSupervisor(false),
    });

    const bridge = new SteerFollowUpBridge(registry, logger);
    const result = bridge.route(makeChannelMessage({
      metadata: { intent: "steer", workerRunId: "run-123" },
    }));

    expect(result).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(agent.steer)).not.toHaveBeenCalled();
    const warnEntries = logger.entries.filter((e) => e.message.includes("no longer active"));
    expect(warnEntries.length).toBe(1);
  });
});
