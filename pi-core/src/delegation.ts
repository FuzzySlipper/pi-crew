/**
 * Delegation types for parent-child session hierarchy.
 *
 * These foundation types are runtime-local: Den correlation can be carried
 * alongside them, but Den is not the delegation coordinator.
 *
 * @module pi-core/delegation
 */

import type { ExecutionPolicy } from "./security.js";

/** Supported top-level and child session kinds. */
export type SessionKind = "conversational" | "worker" | "delegated";

/** Lineage carried by every delegated session. */
export interface DelegationLineage {
  /** Session ID that directly spawned this child. */
  readonly parentSessionId: string;
  /** Original top-level session in the chain. */
  readonly rootSessionId: string;
  /** Session ID for this delegated child. */
  readonly childSessionId: string;
  /** Current nesting depth; first child is depth 1. */
  readonly depth: number;
  /** Chain of session IDs from root to this child, inclusive. */
  readonly chain: readonly string[];
}

/** Input for deriving a child lineage record. */
export interface CreateChildDelegationLineageInput {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly parentLineage?: DelegationLineage | null;
}

/** Delegation-specific constraints layered onto an ExecutionPolicy. */
export interface DelegationConstraints {
  /** Maximum additional spawn depth available to this session. */
  readonly maxSpawnDepth: number;
  /** Maximum simultaneously active child sessions. */
  readonly maxConcurrentChildren?: number;
}

/** Requested child model/profile/provider selection. Omitted fields inherit. */
export interface DelegationModelSelection {
  readonly profileId?: string;
  readonly provider?: string;
  readonly model?: string;
}

/** Resolved child runtime identity after inheritance and allowlist checks. */
export interface EffectiveDelegationRuntime {
  readonly profileId: string;
  readonly provider?: string;
  readonly model?: string;
}

/** Request to spawn a delegated session. */
export interface DelegationSpawnRequest {
  /** Human-readable task or objective for the child session. */
  readonly task: string;
  /** Optional child runtime override request; omitted fields inherit. */
  readonly modelSelection?: DelegationModelSelection;
  /** Tool allowlist for the child; must not exceed parent policy. */
  readonly allowedTools?: readonly string[];
  /** Additional tool denylist entries for the child. */
  readonly deniedTools?: readonly string[];
  /** Requested child spawn depth cap; cannot exceed parent constraints. */
  readonly maxSpawnDepth?: number;
  /** Hard timeout for the delegated session in milliseconds. */
  readonly timeoutMs?: number;
}

/** Result a delegated session produces for its parent. */
export interface DelegatedResult {
  readonly outcome: "success" | "failure" | "timeout" | "killed" | "orphaned";
  readonly summary: string;
  readonly policyId: string;
  readonly childSessionId: string;
  readonly effectiveRuntime?: EffectiveDelegationRuntime;
  readonly tokensConsumed?: number;
  readonly turnsUsed?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

/** Derived policy and lineage for a child session. */
export interface DelegatedPolicyDerivation {
  readonly policy: ExecutionPolicy;
  readonly lineage: DelegationLineage;
}

/** Stable delegation identity shared by visibility events. */
export interface DelegationVisibilityIdentity {
  readonly childSessionId: string;
  readonly lineage: DelegationLineage;
  readonly policyId: string;
  readonly spawnRequestId?: string;
}

/** Create lineage for a child spawned from a top-level or delegated parent. */
export function createChildDelegationLineage(
  input: CreateChildDelegationLineageInput,
): DelegationLineage {
  const parentDepth = input.parentLineage?.depth ?? 0;
  const rootSessionId = input.parentLineage?.rootSessionId ?? input.parentSessionId;
  const parentChain = input.parentLineage?.chain ?? [input.parentSessionId];

  // DESIGN: lineage is append-only and copied per child so parallel children
  // cannot mutate or alias one another's attribution chain.
  return {
    parentSessionId: input.parentSessionId,
    rootSessionId,
    childSessionId: input.childSessionId,
    depth: parentDepth + 1,
    chain: [...parentChain, input.childSessionId],
  };
}
