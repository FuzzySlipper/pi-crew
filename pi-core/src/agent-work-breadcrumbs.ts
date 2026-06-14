/**
 * Agent-work breadcrumb DTOs for durable parent/child activity tracking.
 *
 * Structured breadcrumb rows consumed by Den Web for situational awareness
 * of pi-crew parent and delegated-child activity. Raw transcripts are
 * explicitly excluded — summaries and handles only.
 *
 * DESIGN: Breadcrumb rows are bounded UI/readback evidence, not audit records.
 * Rationale: audit log is a separate channel with its own retention policy.
 *
 * @module pi-core/agent-work-breadcrumbs
 */

import type { IsoTimestamp } from "./types.js";

// ── Enums and literals ──────────────────────────────────────────

/** Discriminator for breadcrumb event families. */
export type AgentWorkEventFamily = "parent" | "delegation" | "tool";

/** Lifecycle state of a breadcrumb row. */
export type AgentWorkBreadcrumbState =
  | "started" | "interim" | "completed" | "failed"
  | "denied" | "timeout" | "orphaned";

/** Severity level for breadcrumb rows. */
export type AgentWorkSeverity = "debug" | "info" | "warn" | "error";

/** Classification of a tool call result. */
export type AgentWorkToolResultClass =
  | "ok" | "error" | "denied" | "redacted" | "truncated";

/** Phase of a tool event. */
export type AgentWorkToolPhase = "called" | "completed" | "denied" | "failed";

/** Event types for parent agent lifecycle breadcrumbs. */
export type ParentLifecycleEventType =
  | "pi_crew.parent.runtime_received"
  | "pi_crew.parent.request_claimed"
  | "pi_crew.parent.turn_started"
  | "pi_crew.parent.tool_called"
  | "pi_crew.parent.tool_completed"
  | "pi_crew.parent.completed"
  | "pi_crew.parent.failed";

/** Event types for delegated child lifecycle breadcrumbs. */
export type DelegationLifecycleEventType =
  | "pi_crew.delegation.spawned"
  | "pi_crew.delegation.turn_started"
  | "pi_crew.delegation.turn_completed"
  | "pi_crew.delegation.tool_called"
  | "pi_crew.delegation.tool_completed"
  | "pi_crew.delegation.tool_denied"
  | "pi_crew.delegation.completed"
  | "pi_crew.delegation.failed"
  | "pi_crew.delegation.timeout"
  | "pi_crew.delegation.orphaned";

/** Union of all agent-work event types. */
export type AgentWorkEventType =
  | ParentLifecycleEventType
  | DelegationLifecycleEventType;

// ── Evidence ────────────────────────────────────────────────────

/**
 * Bounded evidence object for breadcrumb rows. Carries stable handles
 * (message IDs, commit SHAs, doc slugs), never raw transcripts.
 */
export interface AgentWorkEvidence {
  readonly messageIds?: readonly number[];
  readonly commitShas?: readonly string[];
  readonly documentSlugs?: readonly string[];
  readonly filePaths?: readonly string[];
  readonly [key: string]: unknown;
}

// ── Common fields ───────────────────────────────────────────────

/** Fields common to every agent-work breadcrumb row. */
export interface AgentWorkBreadcrumbBase {
  readonly id: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly source: "pi-crew";
  readonly eventType: AgentWorkEventType;
  readonly state: AgentWorkBreadcrumbState;
  readonly createdAt: IsoTimestamp;
  readonly severity: AgentWorkSeverity;
  /** Bounded display text (max 500 chars). */
  readonly summary: string;
  /** Bounded evidence handles — never raw transcripts. */
  readonly evidence: AgentWorkEvidence;
  readonly metadata: Record<string, unknown>;
  readonly eventFamily: AgentWorkEventFamily;
}

// ── Parent lifecycle row ────────────────────────────────────────

/**
 * Correlation keys for parent agent lifecycle grouping.
 * Grouping key: `pi-crew-agent:<agentIdentity>:<sessionId-or-deliveryRequestId>`
 */
export interface ParentLifecycleFields {
  readonly eventFamily: "parent";
  readonly agentIdentity: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly deliveryRequestId?: string;
  readonly sourceMessageId?: number;
  readonly finalMessageId?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly turnId?: number;
}

// ── Delegated child lifecycle row ───────────────────────────────

/**
 * Correlation keys for delegated child lifecycle grouping.
 * Grouping key: `pi-crew-delegation:<childSessionId>`
 */
export interface DelegationLifecycleFields {
  readonly eventFamily: "delegation";
  readonly parentAgentIdentity: string;
  readonly parentSessionId: string;
  readonly rootSessionId: string;
  readonly childSessionId: string;
  readonly profileId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly policyId: string;
  /** Nesting depth (first child is 1). */
  readonly depth: number;
  readonly batchId?: string;
  readonly batchIndex?: number;
  /**
   * Bounded, redacted task excerpt (max 300 chars).
   * DESIGN: Truncated — never the full task prompt.
   */
  readonly taskExcerpt?: string;
}

/** Completion fields for delegation lifecycle rows in terminal states. */
export interface DelegationCompletionFields {
  readonly outcome?: "success" | "failure" | "timeout" | "killed" | "orphaned";
  readonly durationMs?: number;
  readonly turnsUsed?: number;
  readonly tokensConsumed?: number;
  readonly evidenceChecked?: boolean;
  readonly artifactCount?: number;
  readonly failureCategory?: string;
}

// ── Tool event row ──────────────────────────────────────────────

/**
 * Tool event fields. Den Web joins called/completed pairs by
 * `toolCallId` within the parent or child group.
 */
export interface ToolEventFields {
  readonly eventFamily: "tool";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly phase: AgentWorkToolPhase;
  readonly durationMs?: number;
  readonly isError: boolean;
  readonly resultClass: AgentWorkToolResultClass;
  readonly coalescedToolCallCount?: number;
  readonly coalescedCompletedCount?: number;
  readonly ownerSessionId: string;
}

// ── Discriminated union ─────────────────────────────────────────

/** Parent lifecycle breadcrumb row. */
export type ParentLifecycleBreadcrumb = AgentWorkBreadcrumbBase &
  ParentLifecycleFields & { readonly eventType: ParentLifecycleEventType };

/** Delegated child lifecycle breadcrumb row. */
export type DelegationLifecycleBreadcrumb = AgentWorkBreadcrumbBase &
  DelegationLifecycleFields & DelegationCompletionFields &
  { readonly eventType: DelegationLifecycleEventType };

/** Tool event breadcrumb row. */
export type ToolEventBreadcrumb = AgentWorkBreadcrumbBase &
  ToolEventFields &
  { readonly eventType: ParentLifecycleEventType | DelegationLifecycleEventType };

/** Union of all agent-work breadcrumb row types. */
export type AgentWorkBreadcrumb =
  | ParentLifecycleBreadcrumb
  | DelegationLifecycleBreadcrumb
  | ToolEventBreadcrumb;

// ── Raw transcript rejection ────────────────────────────────────

/**
 * Fields that MUST NOT appear in breadcrumb evidence or metadata.
 * DESIGN: Raw transcripts stay in audit/logs, not breadcrumbs.
 */
export const FORBIDDEN_RAW_FIELDS: readonly string[] = [
  "rawTranscript", "rawOutput", "rawInput", "rawParams", "rawResult",
  "fullPrompt", "fullResponse", "transcript", "conversationLog",
  "messageBody", "rawContent",
] as const;

/** Maximum length for task excerpts. */
export const MAX_TASK_EXCERPT_LENGTH = 300;
/** Maximum length for summary text. */
export const MAX_SUMMARY_LENGTH = 500;

// ── Error types ─────────────────────────────────────────────────

/** Error thrown when a breadcrumb DTO construction fails validation. */
export class BreadcrumbValidationError extends Error {
  constructor(
    message: string,
    readonly violations: readonly string[],
  ) {
    super(message);
    this.name = "BreadcrumbValidationError";
  }
}

// ── Validation helpers ──────────────────────────────────────────

/** Check whether an object contains forbidden raw transcript fields. */
export function findForbiddenRawFields(obj: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const field of FORBIDDEN_RAW_FIELDS) {
    if (field in obj) found.push(field);
  }
  return found;
}

/** Truncate a string to a maximum length, appending "…" if truncated. */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

// ── Factory input types ─────────────────────────────────────────

export type CreateParentBreadcrumbInput = Omit<
  ParentLifecycleBreadcrumb, "id" | "source" | "createdAt"
> & { readonly id?: string; readonly createdAt?: IsoTimestamp };

export type CreateDelegationBreadcrumbInput = Omit<
  DelegationLifecycleBreadcrumb, "id" | "source" | "createdAt"
> & { readonly id?: string; readonly createdAt?: IsoTimestamp };

export type CreateToolBreadcrumbInput = Omit<
  ToolEventBreadcrumb, "id" | "source" | "createdAt"
> & { readonly id?: string; readonly createdAt?: IsoTimestamp };

// ── Factory functions ───────────────────────────────────────────

/** Validate and construct a parent lifecycle breadcrumb. */
export function createParentBreadcrumb(
  input: CreateParentBreadcrumbInput,
): ParentLifecycleBreadcrumb {
  validateBreadcrumbInput(input.evidence, input.metadata, input.summary);
  return {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    source: "pi-crew",
    createdAt: input.createdAt ?? new Date().toISOString(),
  } as ParentLifecycleBreadcrumb;
}

/** Validate and construct a delegation lifecycle breadcrumb. */
export function createDelegationBreadcrumb(
  input: CreateDelegationBreadcrumbInput,
): DelegationLifecycleBreadcrumb {
  validateBreadcrumbInput(input.evidence, input.metadata, input.summary);
  const taskExcerpt = input.taskExcerpt
    ? truncateText(input.taskExcerpt, MAX_TASK_EXCERPT_LENGTH)
    : undefined;
  return {
    ...input,
    taskExcerpt,
    id: input.id ?? crypto.randomUUID(),
    source: "pi-crew",
    createdAt: input.createdAt ?? new Date().toISOString(),
  } as DelegationLifecycleBreadcrumb;
}

/** Validate and construct a tool event breadcrumb. */
export function createToolBreadcrumb(
  input: CreateToolBreadcrumbInput,
): ToolEventBreadcrumb {
  validateBreadcrumbInput(input.evidence, input.metadata, input.summary);
  return {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    source: "pi-crew",
    createdAt: input.createdAt ?? new Date().toISOString(),
  } as ToolEventBreadcrumb;
}

// ── Internal validation ─────────────────────────────────────────

function validateBreadcrumbInput(
  evidence: Record<string, unknown>,
  metadata: Record<string, unknown>,
  summary: string,
): void {
  const evidenceForbidden = findForbiddenRawFields(evidence);
  if (evidenceForbidden.length > 0) {
    throw new BreadcrumbValidationError(
      `Raw transcript fields are not allowed in breadcrumb evidence: ${evidenceForbidden.join(", ")}`,
      evidenceForbidden,
    );
  }
  const metadataForbidden = findForbiddenRawFields(metadata);
  if (metadataForbidden.length > 0) {
    throw new BreadcrumbValidationError(
      `Raw transcript fields are not allowed in breadcrumb metadata: ${metadataForbidden.join(", ")}`,
      metadataForbidden,
    );
  }
  if (summary.length > MAX_SUMMARY_LENGTH) {
    throw new BreadcrumbValidationError(
      `Summary exceeds maximum length of ${String(MAX_SUMMARY_LENGTH)} characters (got ${String(summary.length)})`,
      ["summary"],
    );
  }
}

// ── Grouping key helpers ────────────────────────────────────────

/**
 * Compute the Den Web grouping key for a parent lifecycle breadcrumb.
 * Format: `pi-crew-agent:<agentIdentity>:<sessionId-or-deliveryRequestId>`
 */
export function parentGroupingKey(bc: ParentLifecycleBreadcrumb): string {
  const correlationId = bc.deliveryRequestId ?? bc.sessionId;
  return `pi-crew-agent:${bc.agentIdentity}:${correlationId}`;
}

/**
 * Compute the Den Web grouping key for a delegation lifecycle breadcrumb.
 * Format: `pi-crew-delegation:<childSessionId>`
 */
export function delegationGroupingKey(bc: DelegationLifecycleBreadcrumb): string {
  return `pi-crew-delegation:${bc.childSessionId}`;
}
