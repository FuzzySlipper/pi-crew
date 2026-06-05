/**
 * Tests for gateway.ts — Gateway lifecycle, health checks, and events.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FakeLogger, FakeEventBus, ConnectionError } from "@pi-crew/core";
import { loadConfig } from "../config.js";
import { Gateway } from "../gateway.js";

const config = loadConfig({
  den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false },
  health: { port: 19236, host: "127.0.0.1" },
});

const denRequiredConfig = loadConfig({
  den: { coreUrl: "http://den-srv:3030", requiredAtStartup: true },
  health: { port: 19237, host: "127.0.0.1" },
});

let gateway: Gateway;
let logger: FakeLogger;
let eventBus: FakeEventBus;

describe("Gateway", () => {
  beforeAll(() => {
    logger = new FakeLogger();
    eventBus = new FakeEventBus();
    gateway = new Gateway(config, logger, eventBus);
  });

  afterAll(async () => {
    // Ensure gateway is stopped after each test suite
    if (gateway.isRunning) {
      await gateway.stop("test teardown");
    }
  });

  describe("construction", () => {
    it("accepts config, logger, and eventBus via constructor", () => {
      const g = new Gateway(config, logger, eventBus);
      expect(g).toBeInstanceOf(Gateway);
    });

    it("is not running initially", () => {
      const g = new Gateway(config, logger, eventBus);
      expect(g.isRunning).toBe(false);
    });

    it("has no initial shutdown reason", () => {
      const g = new Gateway(config, logger, eventBus);
      expect(g.lastShutdownReason).toBe("");
    });

    it("exposes health config", () => {
      const g = new Gateway(config, logger, eventBus);
      expect(g.healthConfig.port).toBe(19236);
      expect(g.healthConfig.host).toBe("127.0.0.1");
    });
  });

  describe("start", () => {
    it("transitions to running state", async () => {
      const g = new Gateway(config, logger, eventBus);
      await g.start();
      expect(g.isRunning).toBe(true);
      await g.stop("test cleanup");
    });

    it("checks Den reachability when required at startup", async () => {
      const checkedUrls: string[] = [];
      const g = new Gateway(
        denRequiredConfig,
        logger,
        eventBus,
        (coreUrl) => {
          checkedUrls.push(coreUrl);
          return Promise.resolve();
        },
      );

      await g.start();

      expect(checkedUrls).toEqual(["http://den-srv:3030"]);
      await g.stop("test cleanup");
    });

    it("refuses startup when required Den reachability check fails", async () => {
      const g = new Gateway(
        denRequiredConfig,
        logger,
        eventBus,
        () => Promise.reject(new ConnectionError("Den is unreachable")),
      );

      await expect(g.start()).rejects.toThrow("Den is unreachable");
      expect(g.isRunning).toBe(false);
    });

    it("is idempotent — calling start twice is safe", async () => {
      const g = new Gateway(config, logger, eventBus);
      await g.start();
      await g.start(); // second call
      expect(g.isRunning).toBe(true);
      await g.stop("test cleanup");
    });
  });

  describe("stop", () => {
    it("transitions to stopped state", async () => {
      const g = new Gateway(config, logger, eventBus);
      await g.start();
      await g.stop("test");
      expect(g.isRunning).toBe(false);
    });

    it("records shutdown reason", async () => {
      const g = new Gateway(config, logger, eventBus);
      await g.start();
      await g.stop("SIGTERM");
      expect(g.lastShutdownReason).toBe("SIGTERM");
    });

    it("is idempotent", async () => {
      const g = new Gateway(config, logger, eventBus);
      await g.stop("no-op"); // not running
      expect(g.isRunning).toBe(false);
    });

    it("emits gateway.shutdown event", async () => {
      const bus = new FakeEventBus();
      const g2 = new Gateway(config, logger, bus);
      await g2.start();

      let shutdownPayload: unknown = null;
      bus.on("gateway.shutdown", (p) => {
        shutdownPayload = p;
      });

      await g2.stop("test shutdown");
      expect(shutdownPayload).toEqual({ reason: "test shutdown" });
    });
  });
});
