/** Helper functions for delegated spawn lifecycle. */

import type {
  DelegatedResult,
  DelegationSpawnRequest,
  DelegationVisibilityPayload,
  EffectiveDelegationRuntime,
  Result,
} from "@pi-crew/core";
import { err, ok } from "@pi-crew/core";
import type {
  DelegatedSpawnError,
  DelegatedSpawnErrorCode,
  DelegatedSpawnInput,
} from "./delegated-spawn-lifecycle.js";

interface VisibilityIdentityForPayload {
  readonly childSessionId: string;
  readonly lineage: DelegationVisibilityPayload["lineage"];
  readonly policyId: string;
  readonly spawnRequestId?: string;
  readonly correlation: Readonly<Record<string, string | undefined>>;
}

export function normalizeSpawnRequest(input: DelegatedSpawnInput): DelegationSpawnRequest {
  return {
    task: input.spawnRequest?.task ?? input.task,
    modelSelection: input.spawnRequest?.modelSelection,
    allowedTools: input.spawnRequest?.allowedTools,
    deniedTools: input.spawnRequest?.deniedTools,
    maxSpawnDepth: input.spawnRequest?.maxSpawnDepth,
    timeoutMs: input.spawnRequest?.timeoutMs,
    expectedResultSchema: input.spawnRequest?.expectedResultSchema,
    requiredEvidence: input.spawnRequest?.requiredEvidence,
  };
}

export function resolveEffectiveRuntime(
  parentRuntime: EffectiveDelegationRuntime,
  allowedRuntimes: readonly EffectiveDelegationRuntime[],
  requested: DelegationSpawnRequest["modelSelection"],
): Result<EffectiveDelegationRuntime, DelegatedSpawnError> {
  const profileId = requested?.profileId ?? parentRuntime.profileId;
  const profileChanged =
    requested?.profileId !== undefined && requested.profileId !== parentRuntime.profileId;
  const candidate: EffectiveDelegationRuntime = {
    profileId,
    provider: requested?.provider ?? (profileChanged ? undefined : parentRuntime.provider),
    model: requested?.model ?? (profileChanged ? undefined : parentRuntime.model),
  };
  if (allowedRuntimes.length === 0) return ok({ ...candidate });
  if (allowedRuntimes.some((runtime) => sameRuntime(runtime, candidate)))
    return ok({ ...candidate });
  return fail(
    "unsupported_model_selection",
    "Requested child model/profile/provider is not allowed",
  );
}

export async function withTimeout(input: {
  readonly runPromise: Promise<DelegatedResult>;
  readonly timeoutMs: number;
  readonly childSessionId: string;
  readonly policyId: string;
  readonly effectiveRuntime: EffectiveDelegationRuntime;
  readonly startedAt: number;
  readonly abort: AbortController;
}): Promise<DelegatedResult> {
  if (input.timeoutMs <= 0) return timeoutResult(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.runPromise,
      new Promise<DelegatedResult>((resolve) => {
        timer = setTimeout(() => {
          input.abort.abort();
          resolve(timeoutResult(input));
        }, input.timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function fail(
  code: DelegatedSpawnErrorCode,
  message: string,
  detail?: string,
): Result<never, DelegatedSpawnError> {
  return err({ code, message, detail });
}

export function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function basePayload(visibility: VisibilityIdentityForPayload): DelegationVisibilityPayload {
  return {
    ...visibility.correlation,
    childSessionId: visibility.childSessionId,
    lineage: visibility.lineage,
    policyId: visibility.policyId,
    spawnRequestId: visibility.spawnRequestId,
  };
}

function sameRuntime(left: EffectiveDelegationRuntime, right: EffectiveDelegationRuntime): boolean {
  return (
    left.profileId === right.profileId &&
    left.provider === right.provider &&
    left.model === right.model
  );
}

function timeoutResult(input: {
  readonly childSessionId: string;
  readonly policyId: string;
  readonly effectiveRuntime: EffectiveDelegationRuntime;
  readonly startedAt: number;
}): DelegatedResult {
  return {
    outcome: "timeout",
    summary: "Delegated child exceeded its execution timeout",
    policyId: input.policyId,
    childSessionId: input.childSessionId,
    effectiveRuntime: input.effectiveRuntime,
    durationMs: Date.now() - input.startedAt,
  };
}
