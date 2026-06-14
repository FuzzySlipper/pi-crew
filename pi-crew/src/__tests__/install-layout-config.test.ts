/** Tests for installed /home/agents/pi-crew config layout resolution. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigurationError, FakeEventBus, FakeLogger } from "@pi-crew/core";
import { ToolRegistry, type MCPClient } from "@pi-crew/mcp";
import type { Profile } from "@pi-crew/profiles";
import type { McpSurface, McpSurfaceManager } from "../mcp-surface-manager.js";
import { describe, expect, it } from "vitest";

import { loadCrewConfig, resolveCrewConfigPath, resolveCrewInstallLayout } from "../config.js";
import { buildRuntimeResponderFactory } from "../runtime-responder-factory.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-crew-install-layout-"));
}

function repoRoot(): string {
  let current = process.cwd();
  for (let i = 0; i < 4; i += 1) {
    if (existsSync(join(current, "deploy/systemd/install-pi-crew-user-service.sh"))) {
      return current;
    }
    current = join(current, "..");
  }
  throw new Error("repo root not found");
}

function writeInstalledConfig(root: string): string {
  mkdirSync(join(root, "profiles"), { recursive: true });
  const configPath = join(root, "config.yaml");
  writeFileSync(
    configPath,
    [
      "install:",
      `  root: "${root}"`,
      "profiles:",
      `  root: "${join(root, "profiles")}"`,
      "den:",
      '  coreUrl: "http://localhost:3030"',
      "  requiredAtStartup: false",
      "",
    ].join("\n"),
    "utf-8",
  );
  return configPath;
}

function makeClient(): MCPClient {
  return {
    callTool: () => Promise.resolve({ ok: true, content: [{ type: "text", text: "ok" }] }),
  } as unknown as MCPClient;
}

function surfaceManager(registry: ToolRegistry): McpSurfaceManager {
  const client = makeClient();
  return {
    surfaceForProfile: (profile: Profile): McpSurface => ({ endpoint: "http://mcp.test", toolProfile: profile.mcpConfig?.toolProfile, client, registry }),
    connectAll: () => Promise.resolve(),
    disconnectAll: () => Promise.resolve(),
  };
}

describe("installed config layout", () => {
  it("resolves the default installed config path under /home/agents/pi-crew", () => {
    expect(resolveCrewConfigPath({ argv: ["node", "main.js"], env: {}, cwd: "/repo" })).toBe(
      "/home/agents/pi-crew/config.yaml",
    );
  });

  it("keeps explicit config path precedence over the installed default", () => {
    expect(
      resolveCrewConfigPath({
        argv: ["node", "main.js", "--config", "./local.yaml"],
        env: {},
        cwd: "/repo",
      }),
    ).toBe("/repo/local.yaml");
    expect(
      resolveCrewConfigPath({
        argv: ["node", "main.js", "--config", "./local.yaml"],
        env: { PI_CREW_CONFIG: "/tmp/from-env.yaml" },
        cwd: "/repo",
      }),
    ).toBe("/tmp/from-env.yaml");
  });

  it("loads installed root and profile root from config", () => {
    const root = tempRoot();
    const config = loadCrewConfig(writeInstalledConfig(root));
    const layout = resolveCrewInstallLayout(config);

    expect(layout.root).toBe(root);
    expect(layout.configPath).toBe(join(root, "config.yaml"));
    expect(layout.profilesRoot).toBe(join(root, "profiles"));
  });

  it("defaults delegation projection to local log with channel posting disabled", () => {
    const root = tempRoot();
    const config = loadCrewConfig(writeInstalledConfig(root));

    expect(config.delegation.projection.channelEnabled).toBe(false);
    expect(config.delegation.projection.localLogEnabled).toBe(true);
    expect(config.delegation.projection.projectToolCalledEvents).toBe(false);
  });

  it("loads explicit delegation projection sink settings", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    mkdirSync(join(root, "profiles"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "install:",
        `  root: "${root}"`,
        "profiles:",
        `  root: "${join(root, "profiles")}"`,
        "den:",
        '  coreUrl: "http://localhost:3030"',
        "  requiredAtStartup: false",
        "delegation:",
        "  projection:",
        "    channelEnabled: true",
        "    localLogEnabled: false",
        "    projectToolCalledEvents: true",
        "",
      ].join("\n"),
      "utf-8",
    );

    const config = loadCrewConfig(configPath);
    expect(config.delegation.projection.channelEnabled).toBe(true);
    expect(config.delegation.projection.localLogEnabled).toBe(false);
    expect(config.delegation.projection.projectToolCalledEvents).toBe(true);
  });

  it("uses installed profiles root for conversational responder assembly", () => {
    const root = tempRoot();
    const profileDir = join(root, "profiles", "installed-profile");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "profile.yaml"),
      [
        'name: "Installed Profile"',
        'description: "Installed"',
        "modelConfig:",
        '  provider: "openai"',
        '  model: "gpt-4.1-mini"',
        "toolPolicy:",
        "  mode: allow_all",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(profileDir, "soul.md"), "Installed soul.", "utf-8");
    const configPath = join(root, "config.yaml");
    writeFileSync(
      configPath,
      [
        "install:",
        `  root: "${root}"`,
        "den:",
        '  coreUrl: "http://localhost:3030"',
        "  requiredAtStartup: false",
        "conversationalAgents:",
        "  - agentId: installed",
        "    enabled: true",
        "    profileId: installed-profile",
        "    profileIdentity: installed-profile",
        "    memberIdentity: installed-profile",
        "    session:",
        "      ownerId: owner",
        "      sessionId: sess-installed",
        "      maxHistoryMessages: 20",
        "    channels:",
        "      - providerId: den-channels",
        "        channelId: '642'",
        "        subscriptionIdentity: installed:ordinary",
        "    runtime:",
        "      mode: agent",
        "      systemPromptSource: profile",
        "      toolPolicy:",
        "        mode: profile",
        "    lifecycle:",
        "      turnTimeoutMs: 300000",
        "",
      ].join("\n"),
      "utf-8",
    );
    const config = loadCrewConfig(configPath);
    const factory = buildRuntimeResponderFactory(
      config,
      new FakeEventBus(),
      new FakeLogger(),
      surfaceManager(new ToolRegistry(new FakeLogger())),
    );

    expect(() => factory.createResponder({ profileId: "installed-profile" })).not.toThrow();
  });

  it("fails closed when installed profile root is missing", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(
      configPath,
      [
        "install:",
        `  root: "${root}"`,
        "profiles:",
        `  root: "${join(root, "profiles")}"`,
        "den:",
        '  coreUrl: "http://localhost:3030"',
        "  requiredAtStartup: false",
        "",
      ].join("\n"),
      "utf-8",
    );

    expect(() => loadCrewConfig(configPath)).toThrow(ConfigurationError);
  });

  it("wraps missing and malformed installed config as configuration errors", () => {
    const missingRoot = tempRoot();
    expect(() => loadCrewConfig(join(missingRoot, "config.yaml"))).toThrow(ConfigurationError);

    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, "den:\n  coreUrl: [not-valid-yaml", "utf-8");

    expect(() => loadCrewConfig(configPath)).toThrow(ConfigurationError);
  });

  it("redacts malformed YAML parser details that could include secrets", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(
      configPath,
      "den:\n  channelsToken: super-secret-token\n  coreUrl: [not-valid-yaml\n",
      "utf-8",
    );

    expect(() => loadCrewConfig(configPath)).toThrow(/details redacted/);
    expect(() => loadCrewConfig(configPath)).not.toThrow(/super-secret-token/);
  });

  it("prints scripted install paths that match the installed config layout", () => {
    const repo = repoRoot();
    const installRoot = tempRoot();
    const output = execFileSync(
      join(repo, "deploy/systemd/install-pi-crew-user-service.sh"),
      ["--dry-run"],
      {
        cwd: repo,
        env: {
          ...process.env,
          PI_CREW_REPO_DIR: repo,
          PI_CREW_INSTALL_ROOT: installRoot,
        },
        encoding: "utf-8",
      },
    );

    expect(output).toContain(`config path:       ${join(installRoot, "config.yaml")}`);
    expect(output).toContain(`profiles dir:      ${join(installRoot, "profiles")}`);
    expect(output).toContain(`runtime db:        ${join(installRoot, "runtime.db")}`);
    expect(output).not.toContain(".config/pi-crew/config.yaml");
    expect(output).not.toContain(".local/state/pi-crew/runtime.db");
  });
});
