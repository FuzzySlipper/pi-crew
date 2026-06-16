/**
 * Tests for config hardening: degraded mode, per-agent isolation,
 * and the DegradedHealthServer.
 *
 * @module pi-crew/__tests__/config-harden
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { ConfigurationError } from "@pi-crew/core";
import {
  loadCrewConfig,
  loadCrewConfigWithIsolation,
  tryLoadCrewConfigDegraded,
  validateFullAgentConfigIsolated,
} from "../config.js";
import { DegradedHealthServer } from "../degraded-health-server.js";

// ── Helpers ──────────────────────────────────────────────────────────

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-crew-config-harden-"));
}

function writeConfig(root: string, lines: string[]): string {
  const configPath = join(root, "config.yaml");
  mkdirSync(root, { recursive: true });
  writeFileSync(configPath, lines.join("\n"), "utf-8");
  return configPath;
}

function validConfigLines(root: string): string[] {
  return [
    "den:",
    '  coreUrl: "http://localhost:3030"',
    "  requiredAtStartup: false",
    "",
  ];
}

// ── validateFullAgentConfigIsolated ─────────────────────────────────

describe("validateFullAgentConfigIsolated", () => {
  it("returns valid agents when all entries are valid", () => {
    const agents = [
      {
        agentId: "alpha",
        enabled: true,
        profileId: "alpha-profile",
        profileIdentity: "alpha-profile",
        memberIdentity: "alpha-member",
        session: { ownerId: "owner", sessionId: "sess-alpha", maxHistoryMessages: 20 },
        channels: [{ providerId: "den-channels", channelId: "642", subscriptionIdentity: "alpha:ordinary" }],
        lifecycle: { turnTimeoutMs: 300000 },
      },
      {
        agentId: "beta",
        enabled: true,
        profileId: "beta-profile",
        profileIdentity: "beta-profile",
        memberIdentity: "beta-member",
        session: { ownerId: "owner", sessionId: "sess-beta", maxHistoryMessages: 20 },
        channels: [{ providerId: "den-channels", channelId: "642", subscriptionIdentity: "beta:ordinary" }],
        lifecycle: { turnTimeoutMs: 300000 },
      },
    ];

    const { valid, errors } = validateFullAgentConfigIsolated(agents);
    expect(valid).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(valid[0]?.agentId).toBe("alpha");
    expect(valid[1]?.agentId).toBe("beta");
  });

  it("rejects invalid agents and keeps valid ones", () => {
    const agents: unknown[] = [
      {
        agentId: "good-agent",
        enabled: true,
        profileId: "good-profile",
        profileIdentity: "good-profile",
        memberIdentity: "good-member",
        session: { ownerId: "owner", sessionId: "sess-good", maxHistoryMessages: 20 },
        channels: [{ providerId: "den-channels", channelId: "642", subscriptionIdentity: "good:ordinary" }],
        lifecycle: { turnTimeoutMs: 300000 },
      },
      {
        // Bad: missing agentId
        enabled: true,
        profileId: "bad-profile",
        profileIdentity: "bad-profile",
        memberIdentity: "bad-member",
        session: { ownerId: "owner", sessionId: "sess-bad", maxHistoryMessages: 20 },
        channels: [{ providerId: "den-channels", channelId: "642", subscriptionIdentity: "bad:ordinary" }],
        lifecycle: { turnTimeoutMs: 300000 },
      },
      {
        // Bad: null memberIdentity instead of string (typical goofy mistake)
        agentId: "null-member",
        enabled: true,
        profileId: "null-profile",
        profileIdentity: "null-profile",
        memberIdentity: null,
        session: { ownerId: "owner", sessionId: "sess-null", maxHistoryMessages: 20 },
        channels: [{ providerId: "den-channels", channelId: "642", subscriptionIdentity: "null:ordinary" }],
        lifecycle: { turnTimeoutMs: 300000 },
      },
    ];

    const { valid, errors } = validateFullAgentConfigIsolated(agents);
    expect(valid).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(valid[0]?.agentId).toBe("good-agent");
    expect(errors[0]?.field).toBe("fullAgents[1]");
    expect(errors[1]?.field).toBe("fullAgents[2]");
  });
});

// ── loadCrewConfigWithIsolation ─────────────────────────────────────

describe("loadCrewConfigWithIsolation", () => {
  it("passes through valid config unchanged", () => {
    const root = tempRoot();
    const configPath = writeConfig(root, [
      ...validConfigLines(root),
      "fullAgents:",
      "  - agentId: alpha",
      "    enabled: true",
      "    profileId: alpha-profile",
      "    profileIdentity: alpha-profile",
      "    memberIdentity: alpha-member",
      "    session:",
      "      ownerId: owner",
      "      sessionId: sess-alpha",
      "      maxHistoryMessages: 20",
      "    channels:",
      "      - providerId: den-channels",
      "        channelId: '642'",
      "        subscriptionIdentity: alpha:ordinary",
      "    lifecycle:",
      "      turnTimeoutMs: 300000",
    ]);

    const { config, skippedAgentErrors } = loadCrewConfigWithIsolation(configPath);
    expect(config.fullAgents).toHaveLength(1);
    expect(skippedAgentErrors).toHaveLength(0);
  });

  it("skips bad agents and keeps valid ones", () => {
    const root = tempRoot();
    const configPath = writeConfig(root, [
      ...validConfigLines(root),
      "fullAgents:",
      "  - agentId: good-agent",
      "    enabled: true",
      "    profileId: good-profile",
      "    profileIdentity: good-profile",
      "    memberIdentity: good-member",
      "    session:",
      "      ownerId: owner",
      "      sessionId: sess-good",
      "      maxHistoryMessages: 20",
      "    channels:",
      "      - providerId: den-channels",
      "        channelId: '642'",
      "        subscriptionIdentity: good:ordinary",
      "    lifecycle:",
      "      turnTimeoutMs: 300000",
      "  - agentId: bad-agent",
      "    enabled: true",
      "    profileId: bad-profile",
      "    profileIdentity: bad-profile",
      "    memberIdentity: ~             # null instead of string",
      "    session:",
      "      ownerId: owner",
      "      sessionId: sess-bad",
      "      maxHistoryMessages: 20",
      "    channels:",
      "      - providerId: den-channels",
      "        channelId: '642'",
      "        subscriptionIdentity: bad:ordinary",
      "    lifecycle:",
      "      turnTimeoutMs: 300000",
    ]);

    const { config, skippedAgentErrors } = loadCrewConfigWithIsolation(configPath);
    expect(config.fullAgents).toHaveLength(1);
    expect(config.fullAgents[0]?.agentId).toBe("good-agent");
    expect(skippedAgentErrors).toHaveLength(1);
    expect(skippedAgentErrors[0]?.field).toContain("fullAgents[1]");
  });

  it("still throws on infrastructure errors (missing den.coreUrl)", () => {
    const root = tempRoot();
    const configPath = writeConfig(root, [
      "install:",
      `  root: "${root}"`,
    ]);

    expect(() => loadCrewConfigWithIsolation(configPath)).toThrow(ConfigurationError);
  });

  it("still throws on YAML syntax errors", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, ": bad indentation\n  broken: [\n", "utf-8");

    expect(() => loadCrewConfigWithIsolation(configPath)).toThrow(ConfigurationError);
  });
});

// ── tryLoadCrewConfigDegraded ───────────────────────────────────────

describe("tryLoadCrewConfigDegraded", () => {
  it("returns ok=true for valid config", () => {
    const root = tempRoot();
    const configPath = writeConfig(root, validConfigLines(root));

    const result = tryLoadCrewConfigDegraded(configPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.den.coreUrl).toBe("http://localhost:3030");
    }
  });

  it("returns ok=false for missing den.coreUrl", () => {
    const root = tempRoot();
    const configPath = writeConfig(root, ["install:", `  root: "${root}"`]);

    const result = tryLoadCrewConfigDegraded(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.result.errors).toHaveLength(1);
    }
  });

  it("returns ok=false for bad YAML syntax", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, ": bad: [yaml\n", "utf-8");

    const result = tryLoadCrewConfigDegraded(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.result.errors).toHaveLength(1);
    }
  });

  it("returns ok=false for non-existent file", () => {
    const root = tempRoot();
    const configPath = join(root, "nonexistent.yaml");

    const result = tryLoadCrewConfigDegraded(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.result.errors).toHaveLength(1);
    }
  });

  it("succeeds with per-agent isolation when one agent is bad", () => {
    const root = tempRoot();
    const configPath = writeConfig(root, [
      ...validConfigLines(root),
      "fullAgents:",
      "  - agentId: good-agent",
      "    enabled: true",
      "    profileId: good-profile",
      "    profileIdentity: good-profile",
      "    memberIdentity: good-member",
      "    session:",
      "      ownerId: owner",
      "      sessionId: sess-good",
      "      maxHistoryMessages: 20",
      "    channels:",
      "      - providerId: den-channels",
      "        channelId: '642'",
      "        subscriptionIdentity: good:ordinary",
      "    lifecycle:",
      "      turnTimeoutMs: 300000",
      "  - agentId: bad-agent",
      "    enabled: true",
      "    profileId: bad-profile",
      "    profileIdentity: bad-profile",
      "    memberIdentity: ~             # null",
      "    session:",
      "      ownerId: owner",
      "      sessionId: sess-bad",
      "      maxHistoryMessages: 20",
      "    channels:",
      "      - providerId: den-channels",
      "        channelId: '642'",
      "        subscriptionIdentity: bad:ordinary",
      "    lifecycle:",
      "      turnTimeoutMs: 300000",
    ]);

    const result = tryLoadCrewConfigDegraded(configPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.fullAgents).toHaveLength(1);
      expect(result.config.fullAgents[0]?.agentId).toBe("good-agent");
      expect(result.skippedAgentErrors).toHaveLength(1);
    }
  });
});

// ── DegradedHealthServer ────────────────────────────────────────────

describe("DegradedHealthServer", () => {
  async function withServer(
    port: number,
    fn: (server: DegradedHealthServer) => Promise<void>,
  ): Promise<void> {
    const server = new DegradedHealthServer(
      { host: "127.0.0.1", port },
      { errors: [{ field: "config", message: "Test error message" }], configPath: "/tmp/test.yaml" },
    );
    await server.start();
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  }

  it("returns degraded status on GET /", async () => {
    await withServer(19536, async () => {
      const res = await fetch("http://127.0.0.1:19536/");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("degraded");
      expect(body.reason).toBe("invalid_config");
    });
  });

  it("returns degraded status on GET /health", async () => {
    await withServer(19537, async () => {
      const res = await fetch("http://127.0.0.1:19537/health");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("degraded");
    });
  });

  it("returns config error details on GET /admin/config-error", async () => {
    await withServer(19538, async () => {
      const res = await fetch("http://127.0.0.1:19538/admin/config-error");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("degraded");
      expect(body.errors).toBeDefined();
      expect(body.configPath).toBe("/tmp/test.yaml");
    });
  });

  it("returns 404 for unknown routes", async () => {
    await withServer(19539, async () => {
      const res = await fetch("http://127.0.0.1:19539/unknown/route");
      expect(res.status).toBe(404);
    });
  });

  it("honours stop() and rejects after", async () => {
    const server = new DegradedHealthServer(
      { host: "127.0.0.1", port: 19540 },
      { errors: [], configPath: "/tmp/test.yaml" },
    );
    await server.start();
    await server.stop();

    await expect(fetch("http://127.0.0.1:19540/").then((r) => r.status)).rejects.toThrow();
  });
});
