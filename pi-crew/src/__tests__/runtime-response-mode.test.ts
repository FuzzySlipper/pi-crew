/**
 * Runtime response-mode composition tests.
 *
 * @module pi-crew/__tests__/runtime-response-mode
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelMessage, ChannelParticipant } from "@pi-crew/core";
import { ConfigurationError, FakeEventBus, FakeLogger } from "@pi-crew/core";
import { describe, expect, it } from "vitest";

import { Crew, CrewConfigSchema, loadCrewConfig, type CrewConfig } from "../crew.js";

function makeTempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-crew-runtime-test-")), "runtime.db");
}

function makeTestCrewConfig(overrides?: Partial<CrewConfig>): CrewConfig {
  const result = CrewConfigSchema.safeParse({
    database: { path: makeTempDbPath(), wal: true },
    health: { host: "127.0.0.1", port: 30_236 },
    den: {
      coreUrl: "http://localhost:3030",
      requiredAtStartup: false,
    },
    ...overrides,
  });

  if (!result.success) {
    expect.fail(`Invalid test config: ${JSON.stringify(result.error.issues)}`);
  }

  return result.data;
}

function makeTextMessage(text: string): ChannelMessage {
  const sender: ChannelParticipant = {
    id: "test-human",
    displayName: "Test Human",
    kind: "human",
    platform: "den-channels",
  };

  return {
    id: "message-runtime-mode",
    channelId: "runtime-mode-channel",
    sender,
    content: { kind: "text", text },
    timestamp: new Date("2026-06-06T10:34:00.000Z"),
  };
}

describe("runtime response mode composition", () => {
  it("defaults to echo-compatible response mode", () => {
    const result = CrewConfigSchema.safeParse({
      den: { coreUrl: "http://localhost:3030" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime.responseMode).toBe("echo");
      expect(result.data.runtime.deterministicTool.arithmeticToolEnabled).toBe(false);
      expect(result.data.mcp.endpoint).toBe("http://192.168.1.10:5199/mcp");
    }
  });

  it("fails config validation when deterministic mode omits the arithmetic tool flag", () => {
    const result = CrewConfigSchema.safeParse({
      den: { coreUrl: "http://localhost:3030" },
      runtime: { responseMode: "deterministicTool" },
    });

    expect(result.success).toBe(false);
  });

  it("fails YAML config loading when deterministic mode lacks its required config", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-crew-runtime-config-"));
    const configPath = join(dir, "invalid-runtime.yaml");
    writeFileSync(
      configPath,
      [
        "den:",
        "  coreUrl: \"http://localhost:3030\"",
        "runtime:",
        "  responseMode: \"deterministicTool\"",
        "",
      ].join("\n"),
      "utf-8",
    );

    expect(() => loadCrewConfig(configPath)).toThrow(ConfigurationError);
  });

  it("routes sessions through the configured deterministic tool responder", async () => {
    const eventBus = new FakeEventBus();
    const crew = new Crew(
      makeTestCrewConfig({
        runtime: {
          responseMode: "deterministicTool",
          deterministicTool: { arithmeticToolEnabled: true },
        },
      }),
      new FakeLogger(),
      eventBus,
    );

    await crew.start();
    await crew.sessionManager.routeMessage(
      crew.channelProvider,
      makeTextMessage("Please use NON_ECHO_RUNTIME_OK for 19+23."),
    );
    await crew.stop("runtime-mode-test-cleanup");

    const completed = eventBus.emitted.find(
      (event) => event.event === "tool.completed",
    );
    expect(completed?.event).toBe("tool.completed");
    if (completed?.event !== "tool.completed") {
      expect.fail("Expected deterministic tool completion event");
    }
    expect(completed.payload.result).toEqual({
      sum: 42,
      responseText: "NON_ECHO_RUNTIME_OK:42",
    });
  });
});
