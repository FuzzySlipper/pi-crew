import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCronArgs, runPiCrewCronCli } from "../cron-cli.js";

describe("pi-crew cron CLI", () => {
  it("parses list/run/runs commands", () => {
    expect(parseCronArgs(["list"])).toEqual({ kind: "list" });
    expect(parseCronArgs(["run", "--job", "heartbeat"])).toEqual({ kind: "run", jobId: "heartbeat" });
    expect(parseCronArgs(["runs", "--job", "heartbeat", "--limit", "2"])).toEqual({ kind: "runs", jobId: "heartbeat", limit: 2 });
  });

  it("loads config-defined jobs, runs one manually, and reads recent runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cron-cli-"));
    mkdirSync(join(root, "profiles"), { recursive: true });
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, [
      "install:",
      `  root: "${root}"`,
      "profiles:",
      `  root: "${join(root, "profiles")}"`,
      "den:",
      '  coreUrl: "http://localhost:3030"',
      "  requiredAtStartup: false",
      "database:",
      `  path: "${join(root, "runtime.db")}"`,
      "cron:",
      `  scriptRoot: "${root}"`,
      "  jobs:",
      "    - id: heartbeat",
      "      schedule: '* * * * *'",
      "      script: 'printf cli-ok'",
      "",
    ].join("\n"), "utf-8");
    const outputs: string[] = [];
    const base = ["--config", configPath];

    await runPiCrewCronCli({ args: ["list", ...base], write: (text) => outputs.push(text), cwd: root, env: {} });
    expect(outputs[0]).toContain('"heartbeat"');
    await runPiCrewCronCli({ args: ["run", "--job", "heartbeat", ...base], write: (text) => outputs.push(text), cwd: root, env: {} });
    expect(outputs[1]).toContain('"cli-ok"');
    await runPiCrewCronCli({ args: ["runs", "--job", "heartbeat", ...base], write: (text) => outputs.push(text), cwd: root, env: {} });
    expect(outputs[2]).toContain('"succeeded"');
  });
});
