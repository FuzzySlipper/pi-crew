/** Tests for installed /home/agents/pi-crew config layout resolution. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigurationError } from "@pi-crew/core";
import { describe, expect, it } from "vitest";

import {
  loadCrewConfig,
  resolveCrewConfigPath,
  resolveCrewInstallLayout,
} from "../config.js";

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
      "  coreUrl: \"http://localhost:3030\"",
      "  requiredAtStartup: false",
      "",
    ].join("\n"),
    "utf-8",
  );
  return configPath;
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
        "  coreUrl: \"http://localhost:3030\"",
        "  requiredAtStartup: false",
        "",
      ].join("\n"),
      "utf-8",
    );

    expect(() => loadCrewConfig(configPath)).toThrow(ConfigurationError);
  });

  it("wraps missing and malformed installed config as configuration errors", () => {
    expect(() => loadCrewConfig("/home/agents/pi-crew/config.yaml")).toThrow(ConfigurationError);

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
