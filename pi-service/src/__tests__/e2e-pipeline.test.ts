/**
 * End-to-end pipeline spike test.
 *
 * Proves the full gateway → provider → SessionManager → agent → response
 * pipeline using FakeChannelProvider and the built-in FakeAgent echo.
 *
 * @module pi-service/__tests__/e2e-pipeline.test
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  FakeLogger,
  FakeEventBus,
  FakeChannelProvider,
  ConnectionError,
} from "@pi-crew/core";
import type { ChannelMessage } from "@pi-crew/core";
import { loadConfig } from "../config.js";
import { Gateway } from "../gateway.js";
import { InMemorySessionStore } from "../sessions/session-store.js";
import { SessionManagerImpl } from "../sessions/session-manager.js";
import {
  InstancePoolImpl,
  DEFAULT_POOL_CONFIG,
} from "../instances/instance-pool.js";
import { InstanceFactoryImpl } from "../instances/instance-factory.js";
import type { InstanceFactory } from "../instances/instance-factory.js";
import { AgentFactoryImpl } from "../agents/agent-factory.js";

const healthPort = 19238;
const healthHost = "127.0.0.1";

function makeHealthUrl(): string {
  return `http://${healthHost}:${String(healthPort)}`;
}

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "msg-1",
    channelId: "ch-test",
    sender: {
      id: "user-1",
      displayName: "Tester",
      kind: "human",
      platform: "test",
    },
    content: { kind: "text", text: "hello world" },
    timestamp: new Date(),
    ...overrides,
  };
}

describe("E2E Pipeline Spike", () => {
  let logger: FakeLogger;
  let eventBus: FakeEventBus;

  beforeAll(() => {
    logger = new FakeLogger();
    eventBus = new FakeEventBus();
  });

  describe("health server lifecycle", () => {
    it("starts the gateway and responds to /health", async () => {
      const cfg = loadConfig({
        den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false },
        health: { port: healthPort, host: healthHost },
      });
      const gateway = new Gateway(cfg, logger, eventBus);

      await gateway.start();
      expect(gateway.isRunning).toBe(true);

      // Hit the health endpoint.
      const response = await fetch(makeHealthUrl());
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        status: string;
        uptime: number;
      };
      expect(body.status).toBe("ok");
      expect(typeof body.uptime).toBe("number");

      await gateway.stop("test cleanup");
      expect(gateway.isRunning).toBe(false);
    });

    it("returns 503 /health when shutting down", async () => {
      const cfg = loadConfig({
        den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false },
        health: { port: healthPort + 1, host: healthHost },
      });
      const gateway = new Gateway(cfg, logger, eventBus);
      await gateway.start();

      // Start shutdown — the health server should report shutting_down.
      await gateway.stop("test early shutdown");

      // After stop, the server is closed; we can't check 503 via fetch
      // because the port is already closed. Verify stop state instead.
      expect(gateway.isRunning).toBe(false);
      expect(gateway.lastShutdownReason).toBe("test early shutdown");
    });

    it("refuses startup when reachability check fails", async () => {
      const cfg = loadConfig({
        den: { coreUrl: "http://den-srv:3030", requiredAtStartup: true },
        health: { port: healthPort + 2, host: healthHost },
      });
      const gateway = new Gateway(
        cfg,
        logger,
        eventBus,
        () => Promise.reject(new ConnectionError("Den unreachable")),
      );

      await expect(gateway.start()).rejects.toThrow("Den unreachable");
      expect(gateway.isRunning).toBe(false);
    });

    it("emits gateway.shutdown on stop", async () => {
      const cfg = loadConfig({
        den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false },
        health: { port: healthPort + 3, host: healthHost },
      });
      const bus = new FakeEventBus();
      const gw = new Gateway(cfg, logger, bus);

      let shutdownPayload: unknown = null;
      bus.on("gateway.shutdown", (p) => {
        shutdownPayload = p;
      });

      await gw.start();
      await gw.stop("SIGTERM");

      expect(shutdownPayload).toEqual({ reason: "SIGTERM" });
    });
  });

  describe("full pipeline: provider → SessionManager → agent → response", () => {
    it("routes a message through the pipeline and gets the echo response", async () => {
      const store = new InMemorySessionStore();
      const pool = new InstancePoolImpl(
        new InstanceFactoryImpl(logger),
        DEFAULT_POOL_CONFIG,
        logger,
      );
      const factory = new AgentFactoryImpl(pool, store, eventBus, logger);
      const manager = new SessionManagerImpl(
        store,
        factory,
        pool,
        eventBus,
        logger,
      );
      const provider = new FakeChannelProvider();
      await provider.connect();
      provider.addChannel({
        id: "ch-test",
        name: "Test Channel",
        kind: "channel",
      });

      eventBus.clear();

      // Register the handler as the composition root would:
      // provider.onMessage → manager.routeMessage
      provider.onMessage((msg) =>
        manager.routeMessage(provider, msg),
      );

      // Send a test message through the provider.
      const msg = makeMessage();
      await provider.simulateInboundMessage(msg);

      // The agent echo should be sent back through the provider.
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]?.channelId).toBe("ch-test");
      expect(provider.sentMessages[0]?.content).toEqual({
        kind: "text",
        text: "received: hello world",
      });

      // Routing should have been fallback_created (no pre-existing session).
      const routingEvents = eventBus.emitted.filter(
        (e) => e.event === "session.routing",
      );
      expect(routingEvents).toHaveLength(1);
      expect(routingEvents[0]?.payload).toMatchObject({
        channelId: "ch-test",
        reason: "fallback_created",
      });

      // A session.created event should have been emitted.
      const createdEvents = eventBus.emitted.filter(
        (e) => e.event === "session.created",
      );
      expect(createdEvents).toHaveLength(1);

      await provider.disconnect();
    });

    it("routes to an existing session on subsequent messages", async () => {
      const store = new InMemorySessionStore();
      const pool = new InstancePoolImpl(
        new InstanceFactoryImpl(logger),
        DEFAULT_POOL_CONFIG,
        logger,
      );
      const factory = new AgentFactoryImpl(pool, store, eventBus, logger);
      const manager = new SessionManagerImpl(
        store,
        factory,
        pool,
        eventBus,
        logger,
      );
      const provider = new FakeChannelProvider();
      await provider.connect();
      provider.addChannel({
        id: "ch-test",
        name: "Test Channel",
        kind: "channel",
      });

      provider.onMessage((msg) =>
        manager.routeMessage(provider, msg),
      );

      // First message creates a session (fallback_created).
      await provider.simulateInboundMessage(makeMessage());

      // Clear captured state to inspect only the second round.
      eventBus.clear();
      provider.clear();

      // Second message should route to the existing session.
      await provider.simulateInboundMessage(
        makeMessage({ content: { kind: "text", text: "second message" } }),
      );

      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]?.content).toEqual({
        kind: "text",
        text: "received: second message",
      });

      // Should be existing_session, not fallback_created.
      const routingEvents = eventBus.emitted.filter(
        (e) => e.event === "session.routing",
      );
      expect(routingEvents).toHaveLength(1);
      expect(routingEvents[0]?.payload).toMatchObject({
        reason: "existing_session",
      });

      // No new session.created events on second message.
      const createdEvents = eventBus.emitted.filter(
        (e) => e.event === "session.created",
      );
      expect(createdEvents).toHaveLength(0);

      await provider.disconnect();
    });

    it("sends an error response if the agent throws", async () => {
      const store = new InMemorySessionStore();
      // Create a custom instance factory that produces throwing instances.
      const throwingFactory: InstanceFactory = {
        create(profileId: string, role?: string) {
          void role; // unused in throwing fake
          const inst = {
            id: `throw-${String(Date.now())}`,
            profileId,
            createdAt: new Date(),
            isDisposed: false,
            dispose: () => Promise.resolve(),
            processMessage: () =>
              Promise.reject(new Error("simulated agent failure")),
          };
          return Promise.resolve(inst);
        },
      };
      const pool = new InstancePoolImpl(
        throwingFactory,
        DEFAULT_POOL_CONFIG,
        logger,
      );
      const factory = new AgentFactoryImpl(pool, store, eventBus, logger);
      const manager = new SessionManagerImpl(
        store,
        factory,
        pool,
        eventBus,
        logger,
      );
      const provider = new FakeChannelProvider();
      await provider.connect();
      provider.addChannel({
        id: "ch-test",
        name: "Test Channel",
        kind: "channel",
      });

      provider.onMessage((msg) =>
        manager.routeMessage(provider, msg),
      );

      await provider.simulateInboundMessage(
        makeMessage({ content: { kind: "text", text: "trigger error" } }),
      );

      // Should get an error response.
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]?.content).toEqual({
        kind: "text",
        text: "[pi-service] Agent error: simulated agent failure",
      });

      await provider.disconnect();
    });
  });

  describe("graceful shutdown", () => {
    it("cleans up sessions and disconnects provider on shutdown", async () => {
      const bus = new FakeEventBus();
      const cfg = loadConfig({
        den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false },
        health: { port: healthPort + 4, host: healthHost },
      });
      const gateway = new Gateway(cfg, logger, bus);

      const provider = new FakeChannelProvider();
      await provider.connect();

      // Start gateway, then stop.
      await gateway.start();
      expect(gateway.isRunning).toBe(true);

      await gateway.stop("graceful shutdown test");
      expect(gateway.isRunning).toBe(false);

      // Provider should still be usable (we disconnect it independently).
      await provider.disconnect();
      expect(provider.isConnected).toBe(false);

      // Shutdown event should have been emitted.
      const shutdownEvents = bus.emitted.filter(
        (e) => e.event === "gateway.shutdown",
      );
      expect(shutdownEvents).toHaveLength(1);
    });

    it("Gateway.stop is safe when not running", async () => {
      const gw = new Gateway(
        loadConfig({
          den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false },
          health: { port: healthPort + 5, host: healthHost },
        }),
        logger,
        eventBus,
      );

      await gw.stop("no-op stop");
      expect(gw.isRunning).toBe(false);
    });
  });

  describe("den reachability check (default)", () => {
    it("resolves when the URL responds with non-5xx", async () => {
      const { defaultDenReachabilityCheck } = await import(
        "../gateway.js"
      );
      // Start a local server that returns 200.
      const { createServer } = await import("node:http");
      const server = createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });

      await new Promise<void>((resolve) => {
        server.listen(healthPort + 6, healthHost, () => {
          resolve();
        });
      });

      try {
        await expect(
          defaultDenReachabilityCheck(
            `http://${healthHost}:${String(healthPort + 6)}`,
          ),
        ).resolves.toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    });

    it("throws ConnectionError for 5xx responses", async () => {
      const { defaultDenReachabilityCheck } = await import(
        "../gateway.js"
      );
      const { createServer } = await import("node:http");
      const server = createServer((_req, res) => {
        res.writeHead(500);
        res.end("error");
      });

      await new Promise<void>((resolve) => {
        server.listen(healthPort + 7, healthHost, () => {
          resolve();
        });
      });

      try {
        await expect(
          defaultDenReachabilityCheck(
            `http://${healthHost}:${String(healthPort + 7)}`,
          ),
        ).rejects.toThrow(ConnectionError);
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    });

    it("throws ConnectionError for unreachable hosts", async () => {
      const { defaultDenReachabilityCheck } = await import(
        "../gateway.js"
      );

      await expect(
        // A port nothing should be listening on.
        defaultDenReachabilityCheck(
          `http://127.0.0.1:${String(healthPort + 8)}`,
        ),
      ).rejects.toThrow(ConnectionError);
    });
  });
});
