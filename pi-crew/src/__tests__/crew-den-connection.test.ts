/**
 * Den Channels connection wiring tests for the pi-crew composition root.
 *
 * @module pi-crew/__tests__/crew-den-connection
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigurationError, FakeEventBus, FakeLogger } from "@pi-crew/core";

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
      // HTTP cursor fields have safe defaults.
      expect(result.data.den.channelsProjectId).toBe("");
      expect(result.data.den.channelsMemberIdentity).toBe("");
      expect(result.data.den.channelsPollIntervalMs).toBe(5_000);
      expect(result.data.den.channelsPollLimit).toBe(10);
    }
  });

  it("accepts http:// and https:// channelsUrl values", () => {
    for (const url of ["http://192.168.1.10:18081", "https://den-channels.example.com"]) {
      const result = CrewConfigSchema.safeParse({
        den: {
          coreUrl: "http://localhost:3030",
          channelsUrl: url,
        },
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects unsupported channelsUrl protocols", () => {
    const result = CrewConfigSchema.safeParse({
      den: {
        coreUrl: "http://localhost:3030",
        channelsUrl: "ftp://den-k8plus:4201",
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts live Channels URL with HTTP cursor overrides", () => {
    const result = CrewConfigSchema.safeParse({
      den: {
        coreUrl: "http://localhost:3030",
        channelsUrl: "http://192.168.1.10:18081",
        channelsToken: "[REDACTED]",
        channelsProjectId: "pi-crew",
        channelsMemberIdentity: "pi-crew-gateway",
        channelsPollIntervalMs: 10_000,
        channelsPollLimit: 20,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.den.channelsUrl).toBe("http://192.168.1.10:18081");
      expect(result.data.den.channelsProjectId).toBe("pi-crew");
      expect(result.data.den.channelsMemberIdentity).toBe("pi-crew-gateway");
      expect(result.data.den.channelsPollIntervalMs).toBe(10_000);
      expect(result.data.den.channelsPollLimit).toBe(20);
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

  it("creates live WebSocket connection when channelsUrl is ws://", () => {
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

  it("creates live HTTP direct-agent connection when channelsUrl is http://", () => {
    const testLogger = new FakeLogger();
    const liveCrew = new Crew(
      makeTestCrewConfig({
        den: {
          coreUrl: "http://localhost:3030",
          requiredAtStartup: false,
          channelsUrl: "http://192.168.1.10:18081",
          channelsToken: "test-token",
          channelsProjectId: "pi-crew",
          channelsMemberIdentity: "pi-crew-gateway",
        },
      }),
      testLogger,
      new FakeEventBus(),
    );

    expect(liveCrew.channelProvider).toBeDefined();
    expect(
      testLogger.entries.find(
        (e) =>
          e.message === "Creating live Den HTTP direct-agent connection",
      ),
    ).toBeDefined();
  });

  it("fails closed on HTTP channelsUrl with missing projectId", () => {
    expect(() => {
      new Crew(
        makeTestCrewConfig({
          den: {
            coreUrl: "http://localhost:3030",
            requiredAtStartup: false,
            channelsUrl: "http://192.168.1.10:18081",
            channelsMemberIdentity: "pi-crew-gateway",
            // channelsProjectId intentionally omitted
          },
        }),
      );
    }).toThrow(ConfigurationError);
  });

  it("fails closed on HTTP channelsUrl with missing memberIdentity", () => {
    expect(() => {
      new Crew(
        makeTestCrewConfig({
          den: {
            coreUrl: "http://localhost:3030",
            requiredAtStartup: false,
            channelsUrl: "http://192.168.1.10:18081",
            channelsProjectId: "pi-crew",
            // channelsMemberIdentity intentionally omitted
          },
        }),
      );
    }).toThrow(ConfigurationError);
  });

  it("loads default.yaml with live Channels settings", () => {
    const config = loadCrewConfig("pi-crew/config/default.yaml");

    expect(config.den.channelsUrl).toBe("http://192.168.1.10:18081");
    expect(config.den.channelsRetryMaxAttempts).toBe(5);
    expect(config.den.channelsPingIntervalMs).toBe(30_000);
    expect(config.den.channelsConnectionTimeoutMs).toBe(10_000);
    expect(config.den.channelsProjectId).toBe("pi-crew");
    expect(config.den.channelsMemberIdentity).toBe("pi-crew-gateway");
    expect(config.den.channelsPollIntervalMs).toBe(5_000);
    expect(config.den.channelsPollLimit).toBe(10);
  });
});
