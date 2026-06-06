/**
 * Den Channels connection wiring tests for the pi-crew composition root.
 *
 * @module pi-crew/__tests__/crew-den-connection
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FakeEventBus, FakeLogger } from "@pi-crew/core";

import {
  Crew,
  CrewConfigSchema,
  loadCrewConfig,
  type CrewConfig,
} from "../crew.js";

function makeTempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-crew-den-test-")), "runtime.db");
}

function makeTestCrewConfig(overrides?: Partial<CrewConfig>): CrewConfig {
  const parsed = CrewConfigSchema.safeParse({
    database: { path: makeTempDbPath(), wal: true },
    den: {
      coreUrl: "http://localhost:3030",
      requiredAtStartup: false,
    },
    ...overrides,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid test config: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

describe("Den Channels production connection config", () => {
  it("defaults live Channels settings to simulated/offline-safe values", () => {
    const result = CrewConfigSchema.safeParse({
      den: { coreUrl: "http://localhost:3030" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.den.channelsUrl).toBe("");
      expect(result.data.den.channelsToken).toBe("");
      expect(result.data.den.channelsRetryMaxAttempts).toBe(5);
      expect(result.data.den.channelsRetryBaseDelayMs).toBe(200);
      expect(result.data.den.channelsRetryMaxDelayMs).toBe(30_000);
      expect(result.data.den.channelsPingIntervalMs).toBe(30_000);
      expect(result.data.den.channelsConnectionTimeoutMs).toBe(10_000);
    }
  });

  it("rejects non-WebSocket channelsUrl values", () => {
    const result = CrewConfigSchema.safeParse({
      den: {
        coreUrl: "http://localhost:3030",
        channelsUrl: "http://den-k8plus:4201",
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts live Channels URL, token, retry, heartbeat, and timeout overrides", () => {
    const result = CrewConfigSchema.safeParse({
      den: {
        coreUrl: "http://localhost:3030",
        channelsUrl: "wss://den-k8plus:4201",
        channelsToken: "[REDACTED]",
        channelsRetryMaxAttempts: 7,
        channelsRetryBaseDelayMs: 300,
        channelsRetryMaxDelayMs: 20_000,
        channelsPingIntervalMs: 15_000,
        channelsConnectionTimeoutMs: 5_000,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.den.channelsUrl).toBe("wss://den-k8plus:4201");
      expect(result.data.den.channelsToken).toBe("[REDACTED]");
      expect(result.data.den.channelsRetryMaxAttempts).toBe(7);
      expect(result.data.den.channelsPingIntervalMs).toBe(15_000);
      expect(result.data.den.channelsConnectionTimeoutMs).toBe(5_000);
    }
  });

  it("uses simulated connection when channelsUrl is empty", () => {
    const testLogger = new FakeLogger();
    const simCrew = new Crew(
      makeTestCrewConfig(),
      testLogger,
      new FakeEventBus(),
    );

    expect(simCrew.channelProvider).toBeDefined();
    expect(
      testLogger.entries.find(
        (e) =>
          e.message === "No channelsUrl configured — using simulated connection",
      ),
    ).toBeDefined();
  });

  it("creates live WebSocket connection when channelsUrl is set", () => {
    const testLogger = new FakeLogger();
    const liveCrew = new Crew(
      makeTestCrewConfig({
        den: {
          coreUrl: "http://localhost:3030",
          requiredAtStartup: false,
          channelsUrl: "ws://den-k8plus:4201",
          channelsToken: "test-token",
        },
      }),
      testLogger,
      new FakeEventBus(),
    );

    expect(liveCrew.channelProvider).toBeDefined();
    expect(
      testLogger.entries.find(
        (e) => e.message === "Creating live Den WebSocket connection",
      ),
    ).toBeDefined();
  });

  it("loads default.yaml with live Channels settings", () => {
    const config = loadCrewConfig("pi-crew/config/default.yaml");

    expect(config.den.channelsUrl).toBe("ws://den-k8plus:4201");
    expect(config.den.channelsRetryMaxAttempts).toBe(5);
    expect(config.den.channelsPingIntervalMs).toBe(30_000);
    expect(config.den.channelsConnectionTimeoutMs).toBe(10_000);
  });
});
