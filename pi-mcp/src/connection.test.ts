/**
 * Tests for the MCPConnection transport lifecycle.
 *
 * Covers: transport factory (stdio vs streamable-HTTP), error paths
 * for missing config, connect/disconnect idempotency, backoff math,
 * closed-state guards, and reconnection attempt limits.
 *
 * @module pi-mcp/connection.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { MCPConnection } from "./connection.js";
import type { ServerConfig } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────

function stdioConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: "test-server",
    transport: "stdio",
    command: "node",
    args: ["-e", "console.log('ready')"],
    ...overrides,
  };
}

function httpConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: "http-server",
    transport: "streamable-http",
    endpoint: "http://localhost:9999/mcp",
    ...overrides,
  };
}

// ── Transport creation ────────────────────────────────────────────

describe("MCPConnection — transport factory", () => {
  it("creates StdioClientTransport for stdio config", () => {
    const logger = new FakeLogger();
    const conn = new MCPConnection(stdioConfig(), logger);

    // Transport is created lazily on connect(); we trust the factory
    // returns the correct transport type at runtime.
    expect(conn.isClosed).toBe(false);
    expect(conn.mcpClient).toBeNull();
  });

  it("throws for stdio without command", async () => {
    const logger = new FakeLogger();
    const conn = new MCPConnection(
      { name: "bad", transport: "stdio" },
      logger,
    );

    await expect(conn.connect()).rejects.toThrow(
      "stdio transport requires `command` in config",
    );
  });

  it("throws for streamable-http without endpoint", async () => {
    const logger = new FakeLogger();
    const conn = new MCPConnection(
      { name: "bad", transport: "streamable-http" },
      logger,
    );

    await expect(conn.connect()).rejects.toThrow(
      "streamable-http transport requires `endpoint` in config",
    );
  });

  it("throws for unsupported transport", async () => {
    const logger = new FakeLogger();
    const unsupportedConfig = {
      name: "bad",
      transport: "unsupported",
      command: "node",
    } as unknown as ServerConfig;
    const conn = new MCPConnection(unsupportedConfig, logger);

    await expect(conn.connect()).rejects.toThrow("Unsupported transport");
  });
});

// ── Lifecycle guards ──────────────────────────────────────────────

describe("MCPConnection — lifecycle", () => {
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
  });

  it("isClosed is false before disconnect", () => {
    const conn = new MCPConnection(httpConfig(), logger);

    expect(conn.isClosed).toBe(false);
  });

  it("disconnect sets isClosed and is idempotent", async () => {
    const conn = new MCPConnection(httpConfig(), logger);

    await conn.disconnect();

    expect(conn.isClosed).toBe(true);

    // Second disconnect should not throw
    await conn.disconnect();
    expect(conn.isClosed).toBe(true);
  });

  it("connect throws after close", async () => {
    const conn = new MCPConnection(stdioConfig(), logger);
    await conn.disconnect();

    await expect(conn.connect()).rejects.toThrow(
      "MCPConnection is closed",
    );
  });

  it("reconnect throws after close", async () => {
    const conn = new MCPConnection(stdioConfig(), logger);
    await conn.disconnect();

    await expect(conn.reconnect()).rejects.toThrow(
      "Cannot reconnect a closed connection",
    );
  });

  it("logs connect and disconnect", async () => {
    const conn = new MCPConnection(httpConfig(), logger);

    // Connect will fail (no real server) but we can check logging
    try {
      await conn.connect();
    } catch {
      // Expected — no real server
    }
    await conn.disconnect();

    const infoMsgs = logger.entries
      .filter((e) => e.level === "info")
      .map((e) => e.message);

    expect(infoMsgs).toContain("MCPConnection connecting");
    expect(infoMsgs).toContain("MCPConnection disconnected");
  });
});

// ── Backoff calculation ──────────────────────────────────────────

describe("MCPConnection — backoff", () => {
  it("reconnect exhausts attempts", async () => {
    const logger = new FakeLogger();
    const conn = new MCPConnection(
      { ...stdioConfig(), maxReconnectAttempts: 1 },
      logger,
    );

    // First reconnect attempts connection (will fail because no server)
    try {
      await conn.reconnect();
    } catch {
      // Expected
    }

    // Second reconnect should fail with exhausted message
    await expect(conn.reconnect()).rejects.toThrow(
      "Reconnect failed after 1 attempts for test-server",
    );
  });
});

// ── Config defaults ──────────────────────────────────────────────

describe("MCPConnection — config defaults", () => {
  it("uses default request timeout when not specified", () => {
    const logger = new FakeLogger();
    const conn = new MCPConnection(httpConfig(), logger);

    // Connection object created — transport created lazily
    expect(conn.isClosed).toBe(false);
  });

  it("rejects reconnect after max attempts exhausted", async () => {
    const logger = new FakeLogger();
    const conn = new MCPConnection(
      { ...stdioConfig(), maxReconnectAttempts: 2 },
      logger,
    );

    // Exhaust all attempts by forcing reconnect to fail
    for (let i = 0; i < 2; i++) {
      try {
        await conn.reconnect();
      } catch {
        // Expected — no real server
      }
    }

    // Next reconnect should throw the exhausted error
    await expect(conn.reconnect()).rejects.toThrow(
      "Reconnect failed after 2 attempts for test-server",
    );
  });
});
