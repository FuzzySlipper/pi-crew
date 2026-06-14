/**
 * Repository interface for agent-work breadcrumb persistence.
 *
 * Extends the generic Repository contract with correlation-based
 * operations needed for breadcrumb coalescing and lifecycle updates.
 *
 * DESIGN: Separate from generic Repository because breadcrumbs need
 * update-by-correlation (e.g., update a tool_called row when tool_completed
 * arrives, keyed by toolCallId) and family-scoped queries.
 * Rationale: coalescing prevents unbounded row growth for repetitive events.
 *
 * @module pi-core/agent-work-breadcrumb-repository
 */

import type {
  AgentWorkBreadcrumb,
  AgentWorkEventFamily,
} from "./agent-work-breadcrumbs.js";

// ── Correlation filter ──────────────────────────────────────────

/**
 * Filter for querying breadcrumbs by correlation keys.
 *
 * All provided fields are ANDed together.
 */
export interface BreadcrumbCorrelationFilter {
  /** Filter by event family. */
  readonly eventFamily?: AgentWorkEventFamily;
  /** Filter by session ID (parent or child). */
  readonly sessionId?: string;
  /** Filter by child session ID (delegation events). */
  readonly childSessionId?: string;
  /** Filter by tool call ID (tool events). */
  readonly toolCallId?: string;
  /** Filter by project ID. */
  readonly projectId?: string;
  /** Filter by channel ID. */
  readonly channelId?: string;
  /** Filter by event type. */
  readonly eventType?: string;
  /** Filter by grouping key. */
  readonly groupingKey?: string;
}

// ── Update payload ──────────────────────────────────────────────

/**
 * Fields that can be updated on an existing breadcrumb row.
 *
 * Used for coalescing: when a tool_completed event arrives, update
 * the existing tool_called row rather than inserting a new one.
 */
export interface BreadcrumbUpdateFields {
  readonly state?: AgentWorkBreadcrumb["state"];
  readonly summary?: string;
  readonly evidence?: AgentWorkBreadcrumb["evidence"];
  readonly metadata?: Record<string, unknown>;
  // Delegation completion fields
  readonly outcome?: "success" | "failure" | "timeout" | "killed" | "orphaned";
  readonly durationMs?: number;
  readonly turnsUsed?: number;
  readonly tokensConsumed?: number;
  readonly evidenceChecked?: boolean;
  readonly artifactCount?: number;
  readonly failureCategory?: string;
  // Tool event fields
  readonly phase?: "called" | "completed" | "denied" | "failed";
  readonly isError?: boolean;
  readonly resultClass?: "ok" | "error" | "denied" | "redacted" | "truncated";
  readonly coalescedToolCallCount?: number;
  readonly coalescedCompletedCount?: number;
  // Parent fields
  readonly finalMessageId?: number;
  readonly turnId?: number;
}

// ── Repository interface ────────────────────────────────────────

/**
 * Repository for agent-work breadcrumb persistence.
 *
 * Supports:
 * - Append: insert a new breadcrumb row
 * - Update by ID: update a specific row
 * - Update by correlation: find and update rows matching correlation keys
 *   (used for coalescing tool called/completed pairs)
 * - Query by correlation: find rows matching filter criteria
 */
export interface AgentWorkBreadcrumbRepository {
  /**
   * Append a new breadcrumb row.
   *
   * @returns The saved breadcrumb (may have server-assigned fields).
   */
  append(breadcrumb: AgentWorkBreadcrumb): Promise<AgentWorkBreadcrumb>;

  /**
   * Get a breadcrumb by its unique ID.
   *
   * @returns The breadcrumb, or null if not found.
   */
  getById(id: string): Promise<AgentWorkBreadcrumb | null>;

  /**
   * Update a breadcrumb by its ID.
   *
   * @returns The updated breadcrumb, or null if not found.
   */
  updateById(
    id: string,
    updates: BreadcrumbUpdateFields,
  ): Promise<AgentWorkBreadcrumb | null>;

  /**
   * Find and update the first breadcrumb matching the correlation filter.
   *
   * Used for coalescing: when a tool_completed event arrives, find the
   * matching tool_called row by toolCallId and update it.
   *
   * @returns The updated breadcrumb, or null if no match found.
   */
  updateByCorrelation(
    filter: BreadcrumbCorrelationFilter,
    updates: BreadcrumbUpdateFields,
  ): Promise<AgentWorkBreadcrumb | null>;

  /**
   * Query breadcrumbs by correlation filter.
   *
   * @returns Matching breadcrumbs (may be empty).
   */
  queryByCorrelation(
    filter: BreadcrumbCorrelationFilter,
  ): Promise<AgentWorkBreadcrumb[]>;

  /**
   * Delete a breadcrumb by ID.
   */
  deleteById(id: string): Promise<void>;
}
