#!/usr/bin/env -S tsx
/** Operator CLI for config-backed pi-crew cron jobs. */

import { stdout } from "node:process";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { CronScheduler, RuntimeDb, ScriptCronJobExecutor, SqliteCronJobRepository } from "@pi-crew/service";
import { loadCrewConfig, resolveCrewConfigPath } from "./config.js";
import { syncConfiguredCronJobs } from "./cron-jobs.js";

export interface CronCliOptions {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly write?: (text: string) => void;
}

type CronCommand =
  | { readonly kind: "help" }
  | { readonly kind: "list" }
  | { readonly kind: "runs"; readonly jobId: string; readonly limit: number }
  | { readonly kind: "run"; readonly jobId: string };

export async function runPiCrewCronCli(options: CronCliOptions): Promise<number> {
  const command = parseCronArgs(options.args);
  const write = options.write ?? ((text) => stdout.write(`${text}
`));
  if (command.kind === "help") {
    write(usage());
    return 0;
  }
  const configPath = resolveCrewConfigPath({
    argv: options.args,
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
  });
  const config = loadCrewConfig(configPath);
  const db = new RuntimeDb(config.database, new FakeLogger());
  try {
    const repository = new SqliteCronJobRepository(db.handle);
    await syncConfiguredCronJobs(repository, config.cron.jobs, new Date());
    if (command.kind === "list") {
      write(JSON.stringify({ jobs: await repository.list() }, null, 2));
      return 0;
    }
    if (command.kind === "runs") {
      write(JSON.stringify({ runs: await repository.recentRuns(command.jobId, command.limit) }, null, 2));
      return 0;
    }
    const scheduler = new CronScheduler({
      repository,
      executor: new ScriptCronJobExecutor({ scriptRoot: config.cron.scriptRoot }),
      logger: new FakeLogger(),
      eventBus: new FakeEventBus(),
      tickIntervalMs: config.cron.tickIntervalMs,
      staleRunAfterMs: config.cron.staleRunAfterMs,
    });
    write(JSON.stringify({ run: await scheduler.runNow(command.jobId) }, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

export function parseCronArgs(args: readonly string[]): CronCommand {
  const command = firstNonFlag(args) ?? "help";
  if (command === "help" || command === "--help" || command === "-h") return { kind: "help" };
  if (command === "list") return { kind: "list" };
  if (command === "runs") return { kind: "runs", jobId: requireFlag(args, "--job"), limit: numberFlag(args, "--limit", 10) };
  if (command === "run") return { kind: "run", jobId: requireFlag(args, "--job") };
  throw new CronCliError(`Unknown cron command: ${command}`);
}

function firstNonFlag(args: readonly string[]): string | undefined {
  return args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--config" && args[index - 1] !== "--job" && args[index - 1] !== "--limit");
}

function requireFlag(args: readonly string[], flag: string): string {
  const value = readFlag(args, flag);
  if (value === undefined || value.trim().length === 0) throw new CronCliError(`${flag} is required`);
  return value;
}

function numberFlag(args: readonly string[], flag: string, fallback: number): number {
  const value = readFlag(args, flag);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new CronCliError(`${flag} must be a positive integer`);
  return parsed;
}

function readFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function usage(): string {
  return [
    "pi-crew-cron list [--config <path>]",
    "pi-crew-cron run --job <jobId> [--config <path>]",
    "pi-crew-cron runs --job <jobId> [--limit 10] [--config <path>]",
    "",
    "Jobs are loaded from cron.jobs in pi-crew config before every CLI operation.",
    "Cron semantics are UTC-only, minute-granularity, five-field syntax with strict DOM/DOW matching.",
  ].join("\n");
}

export class CronCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronCliError";
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runPiCrewCronCli({ args: process.argv.slice(2) }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
