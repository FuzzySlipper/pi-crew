/**
 * Integration test: worker session creation through the session-kind-aware responder factory.
 *
 * Verifies the full chain from AgentFactoryImpl through InstancePool/InstanceFactory
 * to the responder factory, proving that:
 * - Worker sessions create instances without requiring a conversational agent match.
 * - Conversational sessions still route through the conversational factory.
 *
 * @module pi-crew/__tests__/worker-session-routing.test
 */

import { describe, it, expect } from "vitest";
import { FakeEventBus, FakeLogger, type ChannelContent } from "@pi-crew/core";
import type { AgentResponder, AgentResponderFactory, AgentResponderFactoryContext } from "@pi-crew/service";
import {
  AgentFactoryImpl,
  InstanceFactoryImpl,
  InstancePoolImpl,
  InMemorySessionStore,
} from "@pi-crew/service";
import { SessionKindAwareResponderFactory } from "../session-kind-responder-factory.js";

// ── Fakes ──────────────────────────────────────────────────────

/**
 * A conversational-only factory that rejects any profile not in its allowlist.
 * Simulates the ProfileMappedConversationalRuntimeBuilder behavior.
 */
class StrictConversationalFactory implements AgentResponderFactory {
  public readonly calls: AgentResponderFactoryContext[] = [];
  private readonly allowedProfiles: ReadonlySet<string>;

  constructor(allowedProfiles: readonly string[]) {
    this.allowedProfiles = new Set(allowedProfiles);
  }

  createResponder(context: AgentResponderFactoryContext): AgentResponder {
    if (!this.allowedProfiles.has(context.profileId)) {
      throw new Error(`No configured conversational agent matches profile ${context.profileId}`);
    }
    this.calls.push(context);
    return {
      respond: (): Promise<ChannelContent> => Promise.resolve({ kind: "text", text: `conv:${context.profileId}` }),
    };
  }
}

// ── Helper ─────────────────────────────────────────────────────

function buildTestSetup(allowedProfiles: readonly string[] = ["conv-architect"]) {
  const convFactory = new StrictConversationalFactory(allowedProfiles);
  const kindAwareFactory = new SessionKindAwareResponderFactory(convFactory);
  const logger = new FakeLogger();
  const eventBus = new FakeEventBus();
  const instanceFactory = new InstanceFactoryImpl(logger, kindAwareFactory);
  const pool = new InstancePoolImpl(
    instanceFactory,
    { maxPerProfile: 4, maxTotal: 16, idleTimeoutMs: 8 * 60 * 60 * 1000 },
    logger,
  );
  const sessionStore = new InMemorySessionStore();
  const agentFactory = new AgentFactoryImpl(pool, sessionStore, eventBus, logger);

  return { convFactory, kindAwareFactory, pool, sessionStore, agentFactory, logger, eventBus };
}

// ── Tests ──────────────────────────────────────────────────────

describe("Worker session routing through SessionKindAwareResponderFactory", () => {
  it("worker session creation bypasses conversational factory", async () => {
    const { convFactory, agentFactory, pool } = buildTestSetup();

    const record = await agentFactory.createSession({
      profileId: "coder-worker",
      kind: "worker",
      workerBinding: {
        assignmentId: "1234",
        runId: "run-1",
        taskId: "42",
        projectId: "pi-crew",
        role: "coder",
      },
    });

    expect(record).toBeDefined();
    expect(record.profileId).toBe("coder-worker");
    expect(record.kind).toBe("worker");

    // The strict conversational factory was never called
    expect(convFactory.calls).toHaveLength(0);

    // The instance was acquired and exists in the pool
    expect(record.instanceId).toBeTruthy();
    const instanceId = record.instanceId as string;
    expect(pool.has(instanceId)).toBe(true);
  });

  it("conversational session creation routes through conversational factory", async () => {
    const { convFactory, agentFactory } = buildTestSetup();

    const record = await agentFactory.createSession({
      profileId: "conv-architect",
      kind: "conversational",
      channelBindings: [],
    });

    expect(record).toBeDefined();
    expect(record.profileId).toBe("conv-architect");
    expect(record.kind).toBe("conversational");
    expect(convFactory.calls).toHaveLength(1);
    expect(convFactory.calls[0]?.profileId).toBe("conv-architect");
    expect(convFactory.calls[0]?.kind).toBe("conversational");
  });

  it("worker session with unknown profile does not throw from conversational factory", async () => {
    // This is the exact scenario that caused the original bug:
    // a strict conversational factory would throw "No configured conversational
    // agent matches profile coder-worker" but the session-kind-aware router
    // intercepts before that happens.
    const { convFactory, agentFactory } = buildTestSetup();

    // Must not throw — the strict factory would throw if called
    const record = await agentFactory.createSession({
      profileId: "coder-worker",
      kind: "worker",
      workerBinding: {
        assignmentId: "1234",
        runId: "run-1",
        taskId: "42",
        projectId: "pi-crew",
        role: "coder",
      },
    });

    expect(record.kind).toBe("worker");
    expect(convFactory.calls).toHaveLength(0);
  });

  it("conversational session with unknown profile still throws", async () => {
    // Verify that the conversational factory is still the authority for
    // conversational sessions — unknown profiles should still fail.
    const { agentFactory } = buildTestSetup();

    await expect(
      agentFactory.createSession({
        profileId: "unknown-profile",
        kind: "conversational",
        channelBindings: [],
      }),
    ).rejects.toThrow("No configured conversational agent matches profile unknown-profile");
  });

  it("worker instance has an echo responder that works", async () => {
    const { pool } = buildTestSetup();

    const instance = await pool.acquire("coder-worker", "coder", undefined, undefined, "worker");

    const result = await instance.processMessage({
      id: "msg-1",
      channelId: "ch-1",
      sender: { id: "sender", displayName: "Sender", kind: "human", platform: "test" },
      content: { kind: "text", text: "test" },
      timestamp: new Date(),
    });

    expect(result.kind).toBe("text");
    expect((result as { kind: "text"; text: string }).text).toContain("received: test");
  });
});
