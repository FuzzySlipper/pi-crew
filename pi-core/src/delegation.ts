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
export type SessionKind = "full" | "worker" | "delegated";

/**
 * Handle to a durable artifact produced by a delegated child.
 *
 * DESIGN: Artifacts are references, not payloads. The actual content lives
 * elsewhere (Den document, Den message, file system, git commit). This keeps
 * DelegatedResult bounded and avoids duplicating large payloads.
 * Rationale: parent context flooding is prevented by using handles + safeExcerpt
 * instead of raw child output.
 */
export interface DelegatedArtifactHandle {
  /** Den document slug, if the artifact is a Den doc. */
  readonly slug?: string;
  /** Den message ID, if the artifact is a Den thread message. */
  readonly messageId?: number;
  /** File path, if the artifact is a filesystem file. */
  readonly filePath?: string;
  /** Git commit SHA, if the artifact is a code change. */
  readonly commitSha?: string;
  /** Human-readable description of the artifact. */
  readonly description: string;
  /**
   * Type classification.
   * - den_document: a Den doc/slug
   * - den_message: a Den task-thread or channel message
   * - code_change: a git commit or branch diff
   * - file: a filesystem file (local or remote)
   * - inventory_note: a read-only observation or finding
   */
  readonly type: "den_document" | "den_message" | "code_change" | "file" | "inventory_note";
}

/** Failure category for non-success DelegatedResult outcomes. */
export type DelegatedFailureCategory =
  | "execution_error"
  | "missing_artifact"
  | "policy_denied"
  | "provider_error"
  | "no_progress"
  | "malformed_result"
  | "insufficient_evidence"
  | "budget_exceeded";

export type DelegatedExpectedResultSchema = "review" | "implementation";

export interface DelegatedRequiredEvidence {
  readonly taskIds?: readonly string[];
  readonly requireEvidenceHandles?: boolean;
  readonly requireBranch?: boolean;
  readonly requireHeadCommit?: boolean;
  readonly requireTests?: boolean;
  readonly requireWorkdirStatus?: boolean;
  readonly allowNoCodeChange?: boolean;
}

export type DelegatedReviewDecision =
  | "accepted"
  | "changes_requested"
  | "blocked"
  | "insufficient_evidence";

export type DelegatedReviewStatus = DelegatedReviewDecision;

export interface DelegatedReviewFinding {
  readonly taskId?: string;
  readonly severity: "blocker" | "major" | "minor" | "info";
  readonly category: string;
  readonly summary: string;
  readonly location?: string;
}

export interface DelegatedReviewTaskDecision {
  readonly taskId: string;
  readonly decision: DelegatedReviewDecision;
  readonly summary: string;
  readonly evidenceHandles: readonly DelegatedArtifactHandle[];
  readonly findings?: readonly DelegatedReviewFinding[];
}

export interface DelegatedReviewResult {
  readonly status: DelegatedReviewStatus;
  readonly evidenceHandles: readonly DelegatedArtifactHandle[];
  readonly taskDecisions: readonly DelegatedReviewTaskDecision[];
  readonly findings?: readonly DelegatedReviewFinding[];
}

export type DelegatedImplementationStatus =
  | "implemented"
  | "no_code_change"
  | "blocked"
  | "failed"
  | "insufficient_evidence";

export type DelegatedCheckStatus = "passed" | "failed" | "not_run";

export type DelegatedWorkdirState = "clean" | "dirty_expected" | "dirty_unexpected";

export interface DelegatedImplementationCheck {
  readonly command: string;
  readonly status: DelegatedCheckStatus;
  readonly summary: string;
}

export interface DelegatedImplementationWorkdirStatus {
  readonly state: DelegatedWorkdirState;
  readonly summary: string;
  readonly dirtyFiles?: readonly string[];
}

export interface DelegatedImplementationResult {
  readonly status: DelegatedImplementationStatus;
  readonly taskId?: string;
  readonly branch?: string;
  readonly headCommit?: string;
  readonly noCodeChangeRationale?: string;
  readonly changedFiles?: readonly string[];
  readonly artifactHandles: readonly DelegatedArtifactHandle[];
  readonly checks: readonly DelegatedImplementationCheck[];
  readonly workdirStatus?: DelegatedImplementationWorkdirStatus;
  readonly denHandoffHandles?: readonly DelegatedArtifactHandle[];
}

export type DelegatedStructureRepairOutcome =
  | "not_needed"
  | "repaired"
  | "unrepairable"
  | "repair_invalid";

export interface DelegatedStructureRepair {
  readonly attempted: boolean;
  readonly outcome: DelegatedStructureRepairOutcome;
  readonly changes?: readonly string[];
  readonly warnings?: readonly string[];
}

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
  /** Optional harness-enforced expected result schema. */
  readonly expectedResultSchema?: DelegatedExpectedResultSchema;
  /** Evidence contract required by the parent for this child result. */
  readonly requiredEvidence?: DelegatedRequiredEvidence;
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

  // ── Artifact and evidence fields (#2294) ──────────────────────

  /**
   * Artifact handles produced by the child.
   *
   * DESIGN: Artifacts are handles (slugs, IDs, paths), not payloads.
   * The parent receives bounded references; deep reads happen via
   * those handles. This prevents parent context flooding.
   */
  readonly artifacts?: readonly DelegatedArtifactHandle[];

  /**
   * Failure category for non-success outcomes.
   *
   * DESIGN: typed categories so parents and operators can distinguish
   * "missing_artifact" from "execution_error" from "timeout" without
   * parsing prose. Rationale: missing artifact is a distinct failure
   * mode, not a malformed implementation packet.
   */
  readonly failureCategory?: DelegatedFailureCategory;

  /**
   * Recovery guidance for parent or operator.
   *
   * Design guidance on what the parent should do next (retry, escalate,
   * adjust policy, provide more context, etc.).
   */
  readonly recoveryGuidance?: string;

  /**
   * Tools used during execution.
   *
   * DESIGN: flat string list for diagnostics and budget tracking.
   * Future versions may include per-tool call counts.
   */
  readonly toolsUsed?: readonly string[];

  /**
   * Whether evidence was checked (e.g., git branch/head verified,
   * artifact paths confirmed, test results validated).
   *
   * DESIGN: boolean flag for proof vs claim. When false, the parent
   * or operator should verify independently.
   */
  readonly evidenceChecked?: boolean;

  /**
   * Bounded excerpt safe for parent context injection.
   *
   * DESIGN: the child's full transcript is never injected into the
   * parent context. safeExcerpt provides a bounded view (~1000-2000
   * chars) that fits in a single turn. Rationale: prevents context
   * flooding while giving the parent enough signal for synthesis.
   * Max recommended length: 2000 characters.
   */
  readonly safeExcerpt?: string;

  /** Structured child review result when review-mode delegation is requested. */
  readonly review?: DelegatedReviewResult;

  /** Structured child implementation result when implementation-mode delegation is requested. */
  readonly implementation?: DelegatedImplementationResult;

  /** Bounded metadata describing any structure-only repair applied before validation. */
  readonly structureRepair?: DelegatedStructureRepair;
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
