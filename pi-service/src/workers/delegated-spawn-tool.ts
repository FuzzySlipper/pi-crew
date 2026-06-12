/** Agent tool adapter for service-level delegated spawn lifecycle. */

import type {
  DelegatedResult,
  DelegatedArtifactHandle,
  DelegationConstraints,
  DelegationLineage,
  EffectiveDelegationRuntime,
  ExecutionPolicy,
  Result,
} from "@pi-crew/core";
import type { AgentTool, AgentToolResult } from "./guarded-tool-types.js";
import type {
  DelegatedSpawnCorrelation,
  DelegatedSpawnError,
  DelegatedSpawnInput,
} from "./delegated-spawn-lifecycle.js";

export interface DelegatedSpawnLifecyclePort {
  spawn(input: DelegatedSpawnInput): Promise<Result<DelegatedResult, DelegatedSpawnError>>;
}

interface ParsedSpawnParams {
  readonly task: string;
  readonly modelSelection?: EffectiveDelegationRuntime;
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

export function createDelegatedSpawnTool(options: {
  readonly lifecycle: DelegatedSpawnLifecyclePort;
  readonly parentSessionId: string;
  readonly parentPolicy: ExecutionPolicy;
  readonly parentDelegationConstraints: DelegationConstraints;
  readonly parentLineage?: DelegationLineage | null;
  readonly parentRuntime: EffectiveDelegationRuntime;
  readonly allowedRuntimes?: readonly EffectiveDelegationRuntime[];
  readonly correlation?: DelegatedSpawnCorrelation;
}): AgentTool {
  return {
    label: "Spawn subagent",
    name: "spawn_subagent",
    description: "Spawn one delegated child session and return its structured result.",
    parameters: { type: "object", additionalProperties: true },
    execute: async (_toolCallId, params): Promise<AgentToolResult> => {
      const parsed = parseSpawnParams(params);
      const spawnResult = await options.lifecycle.spawn({
        parentSessionId: options.parentSessionId,
        task: parsed.task,
        parentPolicy: options.parentPolicy,
        parentDelegationConstraints: options.parentDelegationConstraints,
        parentLineage: options.parentLineage,
        parentRuntime: options.parentRuntime,
        allowedRuntimes: options.allowedRuntimes,
        correlation: options.correlation,
        spawnRequest: { task: parsed.task, modelSelection: parsed.modelSelection },
      });
      if (!spawnResult.ok) return toolFailure(spawnResult.error);
      const parentVisibleResult = toParentVisibleResult(spawnResult.value);
      return {
        content: [{ type: "text", text: formatParentVisibleResult(parentVisibleResult) }],
        details: { ok: true, result: parentVisibleResult },
      };
    },
  };
}

function parseSpawnParams(params: unknown): ParsedSpawnParams {
  if (!isRecord(params)) return { task: "delegated child task" };
  const task = typeof params["task"] === "string" ? params["task"] : "delegated child task";
  const selection = params["modelSelection"];
  return { task, modelSelection: isRuntimeSelection(selection) ? selection : undefined };
}

function isRuntimeSelection(value: unknown): value is EffectiveDelegationRuntime {
  if (!isRecord(value)) return false;
  return typeof value["profileId"] === "string"
    && (value["provider"] === undefined || typeof value["provider"] === "string")
    && (value["model"] === undefined || typeof value["model"] === "string");
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

function formatParentVisibleResult(result: ParentVisibleDelegatedResult): string {
  const trustWarning = result.evidenceChecked === false
    ? "\nVerify before trusting: evidenceChecked=false"
    : "";
  return `Delegated child result${trustWarning}\n${JSON.stringify(result, null, 2)}`;
}

function truncate(text: string): string {
  if (text.length <= MAX_SAFE_EXCERPT_CHARS) return text;
  return `${text.slice(0, MAX_SAFE_EXCERPT_CHARS)}… [truncated]`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function toolFailure(error: DelegatedSpawnError): AgentToolResult {
  return {
    content: [{ type: "text", text: `${error.code}: ${error.message}` }],
    details: { ok: false, code: error.code, message: error.message, detail: error.detail },
  };
}
