/**
 * Tests for AgentFactory.
 *
 * @module pi-service/__tests__/agents/agent-factory.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeLogger, FakeEventBus } from "@pi-crew/core";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import { InstancePoolImpl } from "../../instances/instance-pool.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";
import { AgentFactoryImpl } from "../../agents/agent-factory.js";
import { DEFAULT_POOL_CONFIG } from "../../instances/instance-pool.js";
import type { SessionConfig } from "../../sessions/types.js";

describe("AgentFactoryImpl", () => {
  let logger: FakeLogger;
  let eventBus: FakeEventBus;
  let store: InMemorySessionStore;
  let factory: AgentFactoryImpl;

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

    factory = new AgentFactoryImpl(pool, store, eventBus, logger);
  });

  describe("createSession", () => {
    it("creates a conversational session", async () => {
      const config: SessionConfig = {
        profileId: "default",
        kind: "conversational",
        channelBindings: ["ch-test"],
      };

      const record = await factory.createSession(config);

      expect(record.kind).toBe("conversational");
      expect(record.profileId).toBe("default");
      expect(record.channelBindings).toEqual(["ch-test"]);
      expect(record.state).toBe("active");
      expect(record.workerBinding).toBeNull();
      expect(record.instanceId).toBeTruthy();
      expect(record.messageCount).toBe(0);
    });

    it("creates a worker session with worker binding", async () => {
      const config: SessionConfig = {
        profileId: "spawned-coder",
        kind: "worker",
        workerBinding: {
          assignmentId: "201",
          runId: "piw_test",
          taskId: "1856",
          projectId: "pi-crew",
          role: "coder",
        },
      };

      const record = await factory.createSession(config);

      expect(record.kind).toBe("worker");
      expect(record.channelBindings).toEqual([]);
      expect(record.workerBinding).toEqual({
        assignmentId: "201",
        runId: "piw_test",
        taskId: "1856",
        projectId: "pi-crew",
        role: "coder",
      });
    });

    it("emits session.created event", async () => {
      const config: SessionConfig = {
        profileId: "default",
        kind: "conversational",
      };

      const record = await factory.createSession(config);

      const createdEvents = eventBus.emitted.filter(
        (e) => e.event === "session.created",
      );
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents.at(0)?.payload).toMatchObject({
        sessionId: record.id,
        kind: "conversational",
      });
    });

    it("persists the session to the store", async () => {
      const config: SessionConfig = {
        profileId: "default",
        kind: "conversational",
      };

      const record = await factory.createSession(config);
      const retrieved = await store.get(record.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(record.id);
    });

    it("creates sessions with unique IDs", async () => {
      const config: SessionConfig = {
        profileId: "default",
        kind: "conversational",
      };

      const a = await factory.createSession(config);
      const b = await factory.createSession(config);

      expect(a.id).not.toBe(b.id);
    });

    it("acquires a distinct instance per session", async () => {
      const config: SessionConfig = {
        profileId: "default",
        kind: "conversational",
      };

      const a = await factory.createSession(config);
      const b = await factory.createSession(config);

      expect(a.instanceId).toBeTruthy();
      expect(b.instanceId).toBeTruthy();
      expect(a.instanceId).not.toBe(b.instanceId);
    });
  });
});
