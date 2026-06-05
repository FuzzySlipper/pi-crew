/**
 * Tests for SessionManager.
 *
 * @module pi-service/__tests__/sessions/session-manager.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  FakeLogger,
  FakeEventBus,
  FakeChannelProvider,
} from "@pi-crew/core";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import { SessionManagerImpl } from "../../sessions/session-manager.js";
import { InstancePoolImpl } from "../../instances/instance-pool.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";
import { AgentFactoryImpl } from "../../agents/agent-factory.js";
import { DEFAULT_POOL_CONFIG } from "../../instances/instance-pool.js";
import type { SessionConfig } from "../../sessions/types.js";

function makeSessionConfig(
  overrides: Partial<SessionConfig> = {},
): SessionConfig {
  return {
    profileId: "default",
    kind: "conversational",
    ...overrides,
  };
}

describe("SessionManagerImpl", () => {
  let logger: FakeLogger;
  let eventBus: FakeEventBus;
  let store: InMemorySessionStore;
  let manager: SessionManagerImpl;

  beforeEach(() => {
    logger = new FakeLogger();
    eventBus = new FakeEventBus();
    store = new InMemorySessionStore();

    const instanceFactory = new InstanceFactoryImpl(logger);
    const pool = new InstancePoolImpl(
      instanceFactory,
      DEFAULT_POOL_CONFIG,
      logger,
    );
    const agentFactory = new AgentFactoryImpl(
      pool,
      store,
      eventBus,
      logger,
    );

    manager = new SessionManagerImpl(
      store,
      agentFactory,
      pool,
      eventBus,
      logger,
    );
  });

  describe("create", () => {
    it("creates a conversational session", async () => {
      const record = await manager.create(
        makeSessionConfig({ kind: "conversational" }),
      );

      expect(record.kind).toBe("conversational");
      expect(record.state).toBe("active");
      expect(record.instanceId).toBeTruthy();
    });

    it("creates a worker session with worker binding", async () => {
      const record = await manager.create(
        makeSessionConfig({
          kind: "worker",
          workerBinding: {
            assignmentId: "201",
            runId: "piw_test",
            taskId: "1856",
            projectId: "pi-crew",
            role: "coder",
          },
        }),
      );

      expect(record.kind).toBe("worker");
      expect(record.workerBinding).toBeTruthy();
      expect(record.workerBinding?.assignmentId).toBe("201");
      expect(record.channelBindings).toEqual([]);
    });
  });

  describe("get", () => {
    it("returns a session by ID", async () => {
      const record = await manager.create(makeSessionConfig());
      const retrieved = await manager.get(record.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(record.id);
    });

    it("returns null for unknown session", async () => {
      const retrieved = await manager.get("nonexistent");
      expect(retrieved).toBeNull();
    });

    it("returns null for archived session", async () => {
      const record = await manager.create(makeSessionConfig());
      await manager.archive(record.id);

      const retrieved = await manager.get(record.id);
      expect(retrieved).toBeNull();
    });
  });

  describe("findByChannel", () => {
    it("finds a session bound to a channel", async () => {
      const record = await manager.create(
        makeSessionConfig({ channelBindings: ["ch-alpha"] }),
      );

      const found = await manager.findByChannel("ch-alpha");
      expect(found?.id).toBe(record.id);
    });

    it("returns null when no session is bound", async () => {
      const found = await manager.findByChannel("ch-nonexistent");
      expect(found).toBeNull();
    });

    it("does not return archived sessions", async () => {
      const record = await manager.create(
        makeSessionConfig({ channelBindings: ["ch-alpha"] }),
      );
      await manager.archive(record.id);

      const found = await manager.findByChannel("ch-alpha");
      expect(found).toBeNull();
    });
  });

  describe("bindChannel / unbindChannel", () => {
    it("binds a channel to a conversational session", async () => {
      const record = await manager.create(makeSessionConfig());
      await manager.bindChannel(record.id, "ch-beta");

      const updated = await manager.get(record.id);
      expect(updated?.channelBindings).toContain("ch-beta");
    });

    it("does not bind a channel twice", async () => {
      const record = await manager.create(
        makeSessionConfig({ channelBindings: ["ch-beta"] }),
      );
      await manager.bindChannel(record.id, "ch-beta");

      const updated = await manager.get(record.id);
      expect(updated?.channelBindings).toEqual(["ch-beta"]);
    });

    it("does not bind channels to worker sessions", async () => {
      const record = await manager.create(
        makeSessionConfig({ kind: "worker" }),
      );
      await manager.bindChannel(record.id, "ch-beta");

      const updated = await manager.get(record.id);
      expect(updated?.channelBindings).toEqual([]);
    });

    it("unbinds a channel", async () => {
      const record = await manager.create(
        makeSessionConfig({ channelBindings: ["ch-alpha", "ch-beta"] }),
      );
      await manager.unbindChannel(record.id, "ch-alpha");

      const updated = await manager.get(record.id);
      expect(updated?.channelBindings).toEqual(["ch-beta"]);
    });

    it("no-ops when session does not exist", async () => {
      await expect(
        manager.bindChannel("nonexistent", "ch-beta"),
      ).resolves.not.toThrow();
    });
  });

  describe("routeMessage", () => {
    it("routes to existing session bound to channel", async () => {
      const record = await manager.create(
        makeSessionConfig({ channelBindings: ["ch-alpha"] }),
      );

      const provider = new FakeChannelProvider();
      eventBus.clear();

      await manager.routeMessage(provider, {
        id: "msg-1",
        channelId: "ch-alpha",
        sender: { id: "user-1", displayName: "Tester", kind: "human", platform: "test" },
        content: { kind: "text", text: "hello" },
        timestamp: new Date(),
      });

      // Should emit routing event with reason existing_session.
      const routingEvents = eventBus.emitted.filter(
        (e) => e.event === "session.routing",
      );
      expect(routingEvents).toHaveLength(1);
      expect(routingEvents.at(0)?.payload).toMatchObject({
        sessionId: record.id,
        channelId: "ch-alpha",
        reason: "existing_session",
      });
    });

    it("creates a new conversational session as fallback", async () => {
      const provider = new FakeChannelProvider();
      eventBus.clear();

      await manager.routeMessage(provider, {
        id: "msg-1",
        channelId: "ch-new",
        sender: { id: "user-1", displayName: "Tester", kind: "human", platform: "test" },
        content: { kind: "text", text: "hello" },
        timestamp: new Date(),
      });

      // Should emit both session.created and session.routing(fallback_created).
      const createdEvents = eventBus.emitted.filter(
        (e) => e.event === "session.created",
      );
      const routingEvents = eventBus.emitted.filter(
        (e) => e.event === "session.routing",
      );

      expect(createdEvents).toHaveLength(1);
      expect(routingEvents).toHaveLength(1);
      expect(routingEvents.at(0)?.payload).toMatchObject({
        reason: "fallback_created",
        channelId: "ch-new",
      });
    });

    it("prefers existing session over creating new one", async () => {
      const existing = await manager.create(
        makeSessionConfig({ channelBindings: ["ch-alpha"] }),
      );
      eventBus.clear();

      const provider = new FakeChannelProvider();
      await manager.routeMessage(provider, {
        id: "msg-1",
        channelId: "ch-alpha",
        sender: { id: "user-1", displayName: "Tester", kind: "human", platform: "test" },
        content: { kind: "text", text: "hello" },
        timestamp: new Date(),
      });

      const routingEvents = eventBus.emitted.filter(
        (e) => e.event === "session.routing",
      );
      expect(routingEvents).toHaveLength(1);
      expect(routingEvents.at(0)?.payload).toMatchObject({
        sessionId: existing.id,
        reason: "existing_session",
      });

      // No new session should be created.
      const createdEvents = eventBus.emitted.filter(
        (e) => e.event === "session.created",
      );
      expect(createdEvents).toHaveLength(0);
    });
  });

  describe("archive", () => {
    it("archives a session and releases instance", async () => {
      const record = await manager.create(makeSessionConfig());
      await manager.archive(record.id);

      const retrieved = await manager.get(record.id);
      expect(retrieved).toBeNull();

      // Instance should be released from pool.
      const stored = await store.get(record.id);
      expect(stored).toBeNull(); // store.get filters archived

      // Expired event emitted.
      const expiredEvents = eventBus.emitted.filter(
        (e) => e.event === "session.expired",
      );
      expect(expiredEvents).toHaveLength(1);
      expect(expiredEvents.at(0)?.payload).toMatchObject({
        sessionId: record.id,
        reason: "archived",
      });
    });

    it("no-ops for unknown session", async () => {
      await expect(manager.archive("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("evictIdleSessions", () => {
    it("evicts idle sessions and marks records as idle", async () => {
      const shortIdleStore = new InMemorySessionStore();
      const shortIdlePool = new InstancePoolImpl(
        new InstanceFactoryImpl(logger),
        { ...DEFAULT_POOL_CONFIG, idleTimeoutMs: 0 },
        logger,
      );
      const shortIdleAgentFactory = new AgentFactoryImpl(
        shortIdlePool,
        shortIdleStore,
        eventBus,
        logger,
      );
      const shortIdleManager = new SessionManagerImpl(
        shortIdleStore,
        shortIdleAgentFactory,
        shortIdlePool,
        eventBus,
        logger,
      );
      const record = await shortIdleManager.create(makeSessionConfig());

      const result = await shortIdleManager.evictIdleSessions();
      const updated = await shortIdleStore.get(record.id);

      expect(result).toBe(1);
      expect(updated).toMatchObject({
        id: record.id,
        state: "idle",
        instanceId: null,
      });
      expect(shortIdlePool.has(record.instanceId ?? "")).toBe(false);
    });
  });
});
