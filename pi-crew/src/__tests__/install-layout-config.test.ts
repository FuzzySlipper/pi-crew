/** Tests for installed /home/agents/pi-crew config layout resolution. */

import { mkdirSync, writeFileSync } from "node:fs";
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
});
