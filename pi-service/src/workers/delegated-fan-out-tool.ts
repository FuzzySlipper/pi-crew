/** Batch fan-out tool for delegated child sessions. */

import type {
  DelegatedArtifactHandle,
  DelegatedResult,
  DelegationConstraints,
  DelegationLineage,
  EffectiveDelegationRuntime,
  ExecutionPolicy,
} from "@pi-crew/core";
import type { AgentTool, AgentToolResult } from "./guarded-tool-types.js";
import type { DelegatedSpawnCorrelation, DelegatedSpawnInput } from "./delegated-spawn-lifecycle.js";
import type { DelegatedSpawnLifecyclePort } from "./delegated-spawn-tool.js";

interface ParsedFanOutParams {
  readonly tasks: readonly FanOutTask[];
  readonly maxConcurrency?: number;
  readonly failFast: boolean;
}

interface FanOutTask {
  readonly task: string;
  readonly modelSelection?: EffectiveDelegationRuntime;
  readonly timeoutMs?: number;
}

export interface ParentVisibleFanOutResult {
  readonly batchId: string;
  readonly failFast: boolean;
  readonly maxConcurrency: number;
  readonly results: readonly ParentVisibleFanOutItem[];
}

export interface ParentVisibleFanOutItem {
  readonly index: number;
  readonly task: string;
  readonly ok: boolean;
  readonly result?: ParentVisibleDelegatedResult;
  readonly error?: ParentVisibleFanOutError;
}

interface ParentVisibleFanOutError {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}

interface ParentVisibleDelegatedResult {
  readonly outcome: DelegatedResult["outcome"];
  readonly summary: string;
  readonly childSessionId: string;
  readonly policyId: string;
  readonly safeExcerpt?: string;
  readonly artifacts?: readonly DelegatedArtifactHandle[];
  readonly evidenceChecked?: boolean;
  readonly failureCategory?: DelegatedResult["failureCategory"];
  readonly recoveryGuidance?: string;
  readonly toolsUsed?: readonly string[];
  readonly tokensConsumed?: number;
  readonly turnsUsed?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

const MAX_SAFE_EXCERPT_CHARS = 1_600;
let batchCounter = 0;

export function createDelegatedFanOutTool(options: {
  readonly lifecycle: DelegatedSpawnLifecyclePort;
  readonly parentSessionId: string;
  readonly parentPolicy: ExecutionPolicy;
  readonly parentDelegationConstraints: DelegationConstraints;
  readonly parentLineage?: DelegationLineage | null;
  readonly parentRuntime: EffectiveDelegationRuntime;
  readonly allowedRuntimes?: readonly EffectiveDelegationRuntime[];
  readonly correlation?: DelegatedSpawnCorrelation;
  readonly batchId?: () => string;
}): AgentTool {
  return {
    label: "Fan out subagents",
    name: "fan_out_subagents",
    description: "Spawn multiple delegated child sessions with bounded concurrency and indexed results.",
    parameters: { type: "object", additionalProperties: true },
    execute: async (_toolCallId, params): Promise<AgentToolResult> => {
      const parsed = parseFanOutParams(params);
      if (parsed.tasks.length === 0) {
        return { content: [{ type: "text", text: "fan_out_subagents requires a non-empty tasks array" }], details: { ok: false } };
      }
      const batchId = options.batchId?.() ?? nextBatchId();
      const maxConcurrency = resolveMaxConcurrency(parsed, options.parentDelegationConstraints);
      const results = await runBounded({ options, parsed, batchId, maxConcurrency });
      const parentVisible: ParentVisibleFanOutResult = {
        batchId,
        failFast: parsed.failFast,
        maxConcurrency,
        results,
      };
      return {
        content: [{ type: "text", text: `Delegated fan-out result\n${JSON.stringify(parentVisible, null, 2)}` }],
        details: { ok: true, result: parentVisible },
      };
    },
  };
}

async function runBounded(input: {
  readonly options: Parameters<typeof createDelegatedFanOutTool>[0];
  readonly parsed: ParsedFanOutParams;
  readonly batchId: string;
  readonly maxConcurrency: number;
}): Promise<ParentVisibleFanOutItem[]> {
  const results = new Array<ParentVisibleFanOutItem>(input.parsed.tasks.length);
  let cursor = 0;
  let stop = false;

  async function worker(): Promise<void> {
    while (!stop) {
      const index = cursor;
      cursor += 1;
      const task = input.parsed.tasks[index];
      if (task === undefined) return;
      const item = await spawnIndexed(input.options, task, index, input.batchId);
      results[index] = item;
      if (input.parsed.failFast && !item.ok) stop = true;
    }
  }

  await Promise.all(Array.from({ length: input.maxConcurrency }, () => worker()));
  return results.filter((item): item is ParentVisibleFanOutItem => item !== undefined);
}

async function spawnIndexed(
  options: Parameters<typeof createDelegatedFanOutTool>[0],
  task: FanOutTask,
  index: number,
  batchId: string,
): Promise<ParentVisibleFanOutItem> {
  const spawnInput: DelegatedSpawnInput = {
    parentSessionId: options.parentSessionId,
    task: task.task,
    parentPolicy: options.parentPolicy,
    parentDelegationConstraints: options.parentDelegationConstraints,
    parentLineage: options.parentLineage,
    parentRuntime: options.parentRuntime,
    allowedRuntimes: options.allowedRuntimes,
    correlation: { ...options.correlation, batchId, batchIndex: String(index) },
    spawnRequest: { task: task.task, modelSelection: task.modelSelection, timeoutMs: task.timeoutMs },
  };
  const result = await options.lifecycle.spawn(spawnInput);
  if (!result.ok) {
    return {
      index,
      task: task.task,
      ok: false,
      error: { code: result.error.code, message: result.error.message, detail: result.error.detail },
    };
  }
  return { index, task: task.task, ok: true, result: toParentVisibleResult(result.value) };
}

function parseFanOutParams(params: unknown): ParsedFanOutParams {
  if (!isRecord(params)) return { tasks: [], failFast: false };
  const rawTasks = Array.isArray(params["tasks"]) ? params["tasks"] : [];
  return {
    tasks: rawTasks.map(parseTask).filter((task): task is FanOutTask => task !== null),
    maxConcurrency: typeof params["maxConcurrency"] === "number" ? params["maxConcurrency"] : undefined,
    failFast: params["failFast"] === true,
  };
}

function parseTask(value: unknown): FanOutTask | null {
  if (typeof value === "string") return { task: value };
  if (!isRecord(value) || typeof value["task"] !== "string") return null;
  return {
    task: value["task"],
    modelSelection: isRuntimeSelection(value["modelSelection"]) ? value["modelSelection"] : undefined,
    timeoutMs: typeof value["timeoutMs"] === "number" ? value["timeoutMs"] : undefined,
  };
}

function resolveMaxConcurrency(params: ParsedFanOutParams, constraints: DelegationConstraints): number {
  const requested = params.maxConcurrency ?? constraints.maxConcurrentChildren ?? 1;
  const constrained = constraints.maxConcurrentChildren === undefined
    ? requested
    : Math.min(requested, constraints.maxConcurrentChildren);
  return Math.max(1, Math.min(params.tasks.length, constrained));
}

function toParentVisibleResult(result: DelegatedResult): ParentVisibleDelegatedResult {
  return {
    outcome: result.outcome,
    summary: result.summary,
    childSessionId: result.childSessionId,
    policyId: result.policyId,
    ...(result.safeExcerpt === undefined ? {} : { safeExcerpt: truncate(result.safeExcerpt) }),
    ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
    ...(result.evidenceChecked === undefined ? {} : { evidenceChecked: result.evidenceChecked }),
    ...(result.failureCategory === undefined ? {} : { failureCategory: result.failureCategory }),
    ...(result.recoveryGuidance === undefined ? {} : { recoveryGuidance: result.recoveryGuidance }),
    ...(result.toolsUsed === undefined ? {} : { toolsUsed: result.toolsUsed }),
    ...(result.tokensConsumed === undefined ? {} : { tokensConsumed: result.tokensConsumed }),
    ...(result.turnsUsed === undefined ? {} : { turnsUsed: result.turnsUsed }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function isRuntimeSelection(value: unknown): value is EffectiveDelegationRuntime {
  if (!isRecord(value)) return false;
  return typeof value["profileId"] === "string"
    && (value["provider"] === undefined || typeof value["provider"] === "string")
    && (value["model"] === undefined || typeof value["model"] === "string");
}

function truncate(text: string): string {
  if (text.length <= MAX_SAFE_EXCERPT_CHARS) return text;
  return `${text.slice(0, MAX_SAFE_EXCERPT_CHARS)}… [truncated]`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function nextBatchId(): string {
  batchCounter += 1;
  return `delegation-batch-${String(batchCounter)}`;
}
