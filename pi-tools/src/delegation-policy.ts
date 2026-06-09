/**
 * Pure parent-to-child ExecutionPolicy derivation helpers.
 *
 * Delegation policy derivation is amplification-free: a child policy may equal
 * or tighten parent constraints, but it must never expand authority.
 *
 * @module pi-tools/delegation-policy
 */

import type {
  CredentialAccessLevel,
  DelegationConstraints,
  DelegationLineage,
  DelegationSpawnRequest,
  ExecutionPolicy,
  Result,
} from "@pi-crew/core";
import { err, ok } from "@pi-crew/core";
import {
  createExecutionPolicy,
  isHostAllowed,
  isPathAllowed,
} from "./execution-policy.js";

const CREDENTIAL_RANK: Record<CredentialAccessLevel, number> = {
  none: 0,
  read_only: 1,
  bounded_write: 2,
  full: 3,
};

export interface DelegationPolicyConstraints {
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly denyPaths?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly deniedHosts?: readonly string[];
  readonly credentialScope?: CredentialAccessLevel;
  readonly maxDurationMs?: number;
  readonly maxTurnDurationMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxIterations?: number;
  readonly maxTokensPerTurn?: number;
  readonly maxSpawnDepth?: number;
  readonly maxConcurrentChildren?: number;
}

export interface DeriveChildExecutionPolicyInput {
  readonly parentPolicy: ExecutionPolicy;
  readonly lineage: DelegationLineage;
  readonly parentDelegationConstraints: DelegationConstraints;
  readonly requestedPolicy?: DelegationPolicyConstraints;
  readonly spawnRequest?: DelegationSpawnRequest;
  readonly policyId?: string;
}

export interface DelegationPolicyDerivation {
  readonly policy: ExecutionPolicy;
  readonly lineage: DelegationLineage;
  readonly delegationConstraints: DelegationConstraints;
}

export type DelegationPolicyDerivationErrorCode =
  | "allowed_tool_not_in_parent"
  | "allowed_path_not_in_parent"
  | "allowed_host_not_in_parent"
  | "credential_scope_escalation"
  | "duration_budget_escalation"
  | "turn_budget_escalation"
  | "idle_budget_escalation"
  | "iteration_budget_escalation"
  | "token_budget_escalation"
  | "spawn_depth_escalation"
  | "concurrent_children_escalation";

export interface DelegationPolicyDerivationError {
  readonly code: DelegationPolicyDerivationErrorCode;
  readonly message: string;
  readonly field: string;
  readonly value: string | number;
}

export function deriveChildExecutionPolicy(
  input: DeriveChildExecutionPolicyInput,
): Result<DelegationPolicyDerivation, DelegationPolicyDerivationError> {
  const requested = mergeSpawnRequest(input.requestedPolicy, input.spawnRequest);
  const deniedTools = unique([
    ...input.parentPolicy.deniedTools,
    ...(requested.deniedTools ?? []),
  ]);
  const allowedToolsResult = deriveAllowedTools(input.parentPolicy, deniedTools, requested.allowedTools);
  if (!allowedToolsResult.ok) return allowedToolsResult;

  const allowedPathsResult = deriveAllowedPaths(input.parentPolicy, requested.allowedPaths);
  if (!allowedPathsResult.ok) return allowedPathsResult;

  const allowedHostsResult = deriveAllowedHosts(input.parentPolicy, requested.allowedHosts);
  if (!allowedHostsResult.ok) return allowedHostsResult;

  const credentialResult = deriveCredentialScope(input.parentPolicy, requested.credentialScope);
  if (!credentialResult.ok) return credentialResult;

  const durationResult = deriveBoundedNumber(
    "maxDurationMs",
    "duration_budget_escalation",
    input.parentPolicy.maxDurationMs,
    requested.maxDurationMs,
  );
  if (!durationResult.ok) return durationResult;

  const turnResult = deriveBoundedNumber(
    "maxTurnDurationMs",
    "turn_budget_escalation",
    input.parentPolicy.maxTurnDurationMs,
    requested.maxTurnDurationMs,
  );
  if (!turnResult.ok) return turnResult;

  const idleResult = deriveBoundedNumber(
    "idleTimeoutMs",
    "idle_budget_escalation",
    input.parentPolicy.idleTimeoutMs,
    requested.idleTimeoutMs,
  );
  if (!idleResult.ok) return idleResult;

  const iterationResult = deriveBoundedNumber(
    "maxIterations",
    "iteration_budget_escalation",
    input.parentPolicy.maxIterations,
    requested.maxIterations,
  );
  if (!iterationResult.ok) return iterationResult;

  const tokenResult = deriveBoundedNumber(
    "maxTokensPerTurn",
    "token_budget_escalation",
    input.parentPolicy.maxTokensPerTurn,
    requested.maxTokensPerTurn,
  );
  if (!tokenResult.ok) return tokenResult;

  const delegationConstraintsResult = deriveDelegationConstraints(
    input.parentDelegationConstraints,
    requested,
  );
  if (!delegationConstraintsResult.ok) return delegationConstraintsResult;

  const policy = createExecutionPolicy({
    policyId: input.policyId ?? `delegated-${input.lineage.childSessionId}`,
    rootPath: input.parentPolicy.rootPath,
    allowedPaths: allowedPathsResult.value,
    denyPaths: unique([
      ...input.parentPolicy.denyPaths,
      ...(requested.denyPaths ?? []),
    ]),
    allowedTools: allowedToolsResult.value,
    deniedTools,
    allowedHosts: allowedHostsResult.value,
    deniedHosts: unique([
      ...input.parentPolicy.deniedHosts,
      ...(requested.deniedHosts ?? []),
    ]),
    maxDurationMs: durationResult.value,
    maxTurnDurationMs: turnResult.value,
    idleTimeoutMs: idleResult.value,
    maxIterations: iterationResult.value,
    maxTokensPerTurn: tokenResult.value,
    credentialScope: credentialResult.value,
  });

  return ok({
    policy,
    lineage: copyLineage(input.lineage),
    delegationConstraints: delegationConstraintsResult.value,
  });
}

function mergeSpawnRequest(
  requestedPolicy: DelegationPolicyConstraints | undefined,
  spawnRequest: DelegationSpawnRequest | undefined,
): DelegationPolicyConstraints {
  return {
    ...requestedPolicy,
    allowedTools: requestedPolicy?.allowedTools ?? spawnRequest?.allowedTools,
    deniedTools: requestedPolicy?.deniedTools ?? spawnRequest?.deniedTools,
    maxDurationMs: requestedPolicy?.maxDurationMs ?? spawnRequest?.timeoutMs,
    maxSpawnDepth: requestedPolicy?.maxSpawnDepth ?? spawnRequest?.maxSpawnDepth,
  };
}

function deriveAllowedTools(
  parentPolicy: ExecutionPolicy,
  childDeniedTools: readonly string[],
  requestedAllowedTools: readonly string[] | undefined,
): Result<string[], DelegationPolicyDerivationError> {
  const candidates = requestedAllowedTools ?? parentPolicy.allowedTools;
  for (const tool of candidates) {
    if (!isToolAllowedByParent(parentPolicy, tool)) {
      return err(makeError(
        "allowed_tool_not_in_parent",
        "allowedTools",
        tool,
        `Child tool '${tool}' is not allowed by the parent execution policy`,
      ));
    }
  }
  return ok(unique(candidates).filter((tool) => !childDeniedTools.includes(tool)));
}

function isToolAllowedByParent(parentPolicy: ExecutionPolicy, tool: string): boolean {
  if (parentPolicy.deniedTools.includes(tool)) return false;
  return parentPolicy.allowedTools.length === 0 || parentPolicy.allowedTools.includes(tool);
}

function deriveAllowedPaths(
  parentPolicy: ExecutionPolicy,
  requestedAllowedPaths: readonly string[] | undefined,
): Result<string[], DelegationPolicyDerivationError> {
  const candidates = requestedAllowedPaths ?? parentPolicy.allowedPaths;
  for (const targetPath of candidates) {
    if (!isPathAllowed(parentPolicy, targetPath)) {
      return err(makeError(
        "allowed_path_not_in_parent",
        "allowedPaths",
        targetPath,
        `Child path '${targetPath}' is not allowed by the parent execution policy`,
      ));
    }
  }
  return ok(unique(candidates));
}

function deriveAllowedHosts(
  parentPolicy: ExecutionPolicy,
  requestedAllowedHosts: readonly string[] | undefined,
): Result<string[], DelegationPolicyDerivationError> {
  const candidates = requestedAllowedHosts ?? parentPolicy.allowedHosts;
  for (const host of candidates) {
    if (!isHostAllowed(parentPolicy, host)) {
      return err(makeError(
        "allowed_host_not_in_parent",
        "allowedHosts",
        host,
        `Child host '${host}' is not allowed by the parent execution policy`,
      ));
    }
  }
  return ok(unique(candidates));
}

function deriveCredentialScope(
  parentPolicy: ExecutionPolicy,
  requestedScope: CredentialAccessLevel | undefined,
): Result<CredentialAccessLevel, DelegationPolicyDerivationError> {
  const childScope = requestedScope ?? parentPolicy.credentialScope;
  if (CREDENTIAL_RANK[childScope] > CREDENTIAL_RANK[parentPolicy.credentialScope]) {
    return err(makeError(
      "credential_scope_escalation",
      "credentialScope",
      childScope,
      `Child credential scope '${childScope}' exceeds parent scope '${parentPolicy.credentialScope}'`,
    ));
  }
  return ok(childScope);
}

function deriveBoundedNumber(
  field: string,
  code: DelegationPolicyDerivationErrorCode,
  parentValue: number,
  requestedValue: number | undefined,
): Result<number, DelegationPolicyDerivationError> {
  const childValue = requestedValue ?? parentValue;
  if (childValue > parentValue) {
    return err(makeError(
      code,
      field,
      childValue,
      `Child ${field} '${String(childValue)}' exceeds parent value '${String(parentValue)}'`,
    ));
  }
  return ok(childValue);
}

function deriveDelegationConstraints(
  parentConstraints: DelegationConstraints,
  requested: DelegationPolicyConstraints,
): Result<DelegationConstraints, DelegationPolicyDerivationError> {
  const inheritedDepth = Math.max(0, parentConstraints.maxSpawnDepth - 1);
  const childDepth = requested.maxSpawnDepth ?? inheritedDepth;
  if (childDepth > inheritedDepth) {
    return err(makeError(
      "spawn_depth_escalation",
      "maxSpawnDepth",
      childDepth,
      `Child maxSpawnDepth '${String(childDepth)}' exceeds inherited cap '${String(inheritedDepth)}'`,
    ));
  }

  const childConcurrent = requested.maxConcurrentChildren ?? parentConstraints.maxConcurrentChildren;
  if (
    parentConstraints.maxConcurrentChildren !== undefined
    && childConcurrent !== undefined
    && childConcurrent > parentConstraints.maxConcurrentChildren
  ) {
    return err(makeError(
      "concurrent_children_escalation",
      "maxConcurrentChildren",
      childConcurrent,
      `Child maxConcurrentChildren '${String(childConcurrent)}' exceeds parent cap '${String(parentConstraints.maxConcurrentChildren)}'`,
    ));
  }

  return ok(childConcurrent === undefined
    ? { maxSpawnDepth: childDepth }
    : { maxSpawnDepth: childDepth, maxConcurrentChildren: childConcurrent });
}

function copyLineage(lineage: DelegationLineage): DelegationLineage {
  return {
    parentSessionId: lineage.parentSessionId,
    rootSessionId: lineage.rootSessionId,
    childSessionId: lineage.childSessionId,
    depth: lineage.depth,
    chain: [...lineage.chain],
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function makeError(
  code: DelegationPolicyDerivationErrorCode,
  field: string,
  value: string | number,
  message: string,
): DelegationPolicyDerivationError {
  return { code, field, value, message };
}
