/** Cron job executor that runs bounded local shell scripts. */

import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChannelProvider, Logger } from "@pi-crew/core";
import type { CronJobExecutionResult, CronJobExecutor, CronJobRecord, CronRunRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 32_000;

export interface ScriptCronJobExecutorOptions {
  readonly scriptRoot: string;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
  readonly maxBuffer?: number;
  readonly channelProvider?: ChannelProvider;
  readonly logger?: Logger;
}

export class ScriptCronJobExecutor implements CronJobExecutor {
  readonly #scriptRoot: string;
  readonly #timeoutMs: number;
  readonly #maxOutputChars: number;
  readonly #maxBuffer: number;
  readonly #channelProvider: ChannelProvider | null;
  readonly #logger: Logger | null;

  constructor(options: ScriptCronJobExecutorOptions) {
    this.#scriptRoot = resolve(options.scriptRoot);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
    this.#maxBuffer = options.maxBuffer ?? 2_000_000;
    this.#channelProvider = options.channelProvider ?? null;
    this.#logger = options.logger ?? null;
  }

  async execute(job: CronJobRecord, run: CronRunRecord): Promise<CronJobExecutionResult> {
    const result = await this.executeScript(job);
    const deliveryErrorMessage = await this.tryDeliver(job, run, result);
    if (deliveryErrorMessage === null) return result;
    return { ...result, errorMessage: appendErrorMessage(result.errorMessage, deliveryErrorMessage) };
  }

  #truncate(value: string): string {
    return value.length <= this.#maxOutputChars
      ? value
      : `${value.slice(0, this.#maxOutputChars)}\n[truncated]`;
  }

  private async executeScript(job: CronJobRecord): Promise<CronJobExecutionResult> {
    const cwd = resolveInsideRoot(this.#scriptRoot, job.cwd ?? ".");
    try {
      const result = await execFileAsync("bash", ["-lc", job.script], {
        cwd,
        timeout: this.#timeoutMs,
        maxBuffer: this.#maxBuffer,
      });
      return { status: "succeeded", stdout: this.#truncate(result.stdout), stderr: this.#truncate(result.stderr), exitCode: 0, errorMessage: null };
    } catch (error: unknown) {
      return executionFailure(error);
    }
  }

  private async tryDeliver(
    job: CronJobRecord,
    run: CronRunRecord,
    result: CronJobExecutionResult,
  ): Promise<string | null> {
    try {
      await this.deliver(job, run, result.stdout, result.stderr, result.status, result.errorMessage);
      return null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger?.warn("Cron delivery failed", { jobId: job.id, runId: run.id, error: message });
      return `delivery failed: ${message}`;
    }
  }

  private async deliver(
    job: CronJobRecord,
    run: CronRunRecord,
    stdout: string,
    stderr: string,
    status: string,
    errorMessage: string | null,
  ): Promise<void> {
    if (this.#channelProvider === null || job.deliveryChannelId === null) return;
    await this.#channelProvider.sendMessage(job.deliveryChannelId, {
      kind: "text",
      text: renderDelivery(job, run, stdout, stderr, status, errorMessage),
      metadata: { type: "cron_run", jobId: job.id, runId: run.id, status },
    });
  }
}

function executionFailure(error: unknown): CronJobExecutionResult {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      status: "failed",
      stdout: truncate(MAX_OUTPUT_CHARS, typeof record["stdout"] === "string" ? record["stdout"] : ""),
      stderr: truncate(MAX_OUTPUT_CHARS, typeof record["stderr"] === "string" ? record["stderr"] : ""),
      exitCode: typeof record["code"] === "number" ? record["code"] : null,
      errorMessage: error instanceof Error ? error.message : "cron script failed",
    };
  }
  return { status: "failed", stdout: "", stderr: "", exitCode: null, errorMessage: String(error) };
}

function appendErrorMessage(current: string | null, deliveryError: string): string {
  return current === null || current.length === 0 ? deliveryError : `${current}; ${deliveryError}`;
}

function renderDelivery(
  job: CronJobRecord,
  run: CronRunRecord,
  stdout: string,
  stderr: string,
  status: string,
  errorMessage: string | null,
): string {
  const sections = [`cron job ${job.id} run ${run.id} ${status}`];
  if (errorMessage !== null) sections.push(`error:\n${errorMessage}`);
  if (stdout.trim().length > 0) sections.push(`stdout:\n${stdout}`);
  if (stderr.trim().length > 0) sections.push(`stderr:\n${stderr}`);
  return sections.join("\n\n");
}

function resolveInsideRoot(rootPath: string, requested: string): string {
  const path = resolve(rootPath, requested);
  const rel = relative(rootPath, path);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new CronExecutionError(`cron cwd escapes script root: ${requested}`);
  }
  return path;
}

function truncate(maxChars: number, value: string): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated]`;
}

export class CronExecutionError extends Error {
  readonly code = "CRON_EXECUTION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "CronExecutionError";
  }
}
