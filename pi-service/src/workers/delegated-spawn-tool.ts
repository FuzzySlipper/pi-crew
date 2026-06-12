/** Agent tool adapter for service-level delegated spawn lifecycle. */

import type {
  DelegatedResult,
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
      return {
        content: [{ type: "text", text: spawnResult.value.summary }],
        details: { ok: true, result: spawnResult.value },
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function toolFailure(error: DelegatedSpawnError): AgentToolResult {
  return {
    content: [{ type: "text", text: `${error.code}: ${error.message}` }],
    details: { ok: false, code: error.code, message: error.message, detail: error.detail },
  };
}
