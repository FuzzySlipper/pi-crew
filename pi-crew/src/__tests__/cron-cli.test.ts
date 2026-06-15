import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("treats config jobs as source of truth when a job is removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cron-cli-"));
    mkdirSync(join(root, "profiles"), { recursive: true });
    const configPath = join(root, "config.yaml");
    writeCronConfig(configPath, root, ["old-job", "kept-job"]);
    const outputs: string[] = [];
    const base = ["--config", configPath];

    await runPiCrewCronCli({ args: ["list", ...base], write: (text) => outputs.push(text), cwd: root, env: {} });
    expect(outputs[0]).toContain('"old-job"');
    expect(outputs[0]).toContain('"kept-job"');

    writeCronConfig(configPath, root, ["kept-job"]);
    await runPiCrewCronCli({ args: ["list", ...base], write: (text) => outputs.push(text), cwd: root, env: {} });
    expect(outputs[1]).not.toContain('"old-job"');
    expect(outputs[1]).toContain('"kept-job"');
  });

  it("fails malformed --config rather than reading the installed default", async () => {
    await expect(runPiCrewCronCli({ args: ["list", "--config"], cwd: "/tmp", env: {} })).rejects.toThrow("--config requires a path value");
  });

});


function writeCronConfig(configPath: string, root: string, jobIds: readonly string[]): void {
  const jobs = jobIds.flatMap((jobId) => [
    `    - id: ${jobId}`,
    "      schedule: '* * * * *'",
    `      script: 'printf ${jobId}'`,
  ]);
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
    ...jobs,
    "",
  ].join("\n"), "utf-8");
  expect(readFileSync(configPath, "utf-8")).toContain("cron:");
}
