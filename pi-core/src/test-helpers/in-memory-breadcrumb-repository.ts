/**
 * In-memory implementation of AgentWorkBreadcrumbRepository for testing.
 *
 * Backed by a Map, supports all repository operations including
 * correlation-based queries and updates.
 *
 * @module pi-core/test-helpers/in-memory-breadcrumb-repository
 */

import type {
  AgentWorkBreadcrumb,
  AgentWorkEventFamily,
  ParentLifecycleBreadcrumb,
  DelegationLifecycleBreadcrumb,
  ToolEventBreadcrumb,
} from "../agent-work-breadcrumbs.js";
import type {
  AgentWorkBreadcrumbRepository,
  BreadcrumbCorrelationFilter,
  BreadcrumbUpdateFields,
} from "../agent-work-breadcrumb-repository.js";

/**
 * In-memory AgentWorkBreadcrumbRepository for unit tests.
 *
 * Stores breadcrumbs in a Map keyed by ID. Correlation queries
 * perform linear scans — acceptable for test-scale data.
 */
export class InMemoryBreadcrumbRepository
  implements AgentWorkBreadcrumbRepository
{
  private readonly store = new Map<string, AgentWorkBreadcrumb>();

  // ── Repository contract ────────────────────────────────────────

  append(breadcrumb: AgentWorkBreadcrumb): Promise<AgentWorkBreadcrumb> {
    this.store.set(breadcrumb.id, breadcrumb);
    return Promise.resolve(breadcrumb);
  }

  getById(id: string): Promise<AgentWorkBreadcrumb | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  updateById(
    id: string,
    updates: BreadcrumbUpdateFields,
  ): Promise<AgentWorkBreadcrumb | null> {
    const existing = this.store.get(id);
    if (!existing) return Promise.resolve(null);

    const updated = applyUpdates(existing, updates);
    this.store.set(id, updated);
    return Promise.resolve(updated);
  }

  updateByCorrelation(
    filter: BreadcrumbCorrelationFilter,
    updates: BreadcrumbUpdateFields,
  ): Promise<AgentWorkBreadcrumb | null> {
    for (const [id, breadcrumb] of this.store) {
      if (matchesFilter(breadcrumb, filter)) {
        const updated = applyUpdates(breadcrumb, updates);
        this.store.set(id, updated);
        return Promise.resolve(updated);
      }
    }
    return Promise.resolve(null);
  }

  queryByCorrelation(
    filter: BreadcrumbCorrelationFilter,
  ): Promise<AgentWorkBreadcrumb[]> {
    const results: AgentWorkBreadcrumb[] = [];
    for (const breadcrumb of this.store.values()) {
      if (matchesFilter(breadcrumb, filter)) {
        results.push(breadcrumb);
      }
    }
    const ordered = filter.order === "newest" ? results.reverse() : results;
    return Promise.resolve(
      filter.limit === undefined ? ordered : ordered.slice(0, Math.max(0, filter.limit)),
    );
  }

  deleteById(id: string): Promise<void> {
    this.store.delete(id);
    return Promise.resolve();
  }

  // ── Test helpers ───────────────────────────────────────────────

  /** Number of breadcrumbs currently stored. */
  get size(): number {
    return this.store.size;
  }

  /** Remove all breadcrumbs (useful in beforeEach). */
  clear(): void {
    this.store.clear();
  }

  /** Get all stored breadcrumbs as an array. */
  getAll(): AgentWorkBreadcrumb[] {
    return [...this.store.values()];
  }
}

// ── Internal helpers ────────────────────────────────────────────

/**
 * Check whether a breadcrumb matches a correlation filter.
 * All provided filter fields must match (AND semantics).
 */
function matchesFilter(
  breadcrumb: AgentWorkBreadcrumb,
  filter: BreadcrumbCorrelationFilter,
): boolean {
  if (filter.eventFamily !== undefined && breadcrumb.eventFamily !== filter.eventFamily) {
    return false;
  }

  if (filter.projectId !== undefined && breadcrumb.projectId !== filter.projectId) {
    return false;
  }

  if (filter.channelId !== undefined && breadcrumb.channelId !== filter.channelId) {
    return false;
  }

  if (filter.eventType !== undefined && breadcrumb.eventType !== filter.eventType) {
    return false;
  }

  // Session ID matching — depends on event family
  if (filter.sessionId !== undefined) {
    if (breadcrumb.eventFamily === "parent") {
      if ((breadcrumb as ParentLifecycleBreadcrumb).sessionId !== filter.sessionId) {
        return false;
      }
    } else if (breadcrumb.eventFamily === "delegation") {
      const del = breadcrumb as DelegationLifecycleBreadcrumb;
      if (
        del.parentSessionId !== filter.sessionId &&
        del.childSessionId !== filter.sessionId &&
        del.rootSessionId !== filter.sessionId
      ) {
        return false;
      }
    } else if (breadcrumb.eventFamily === "tool") {
      if ((breadcrumb as ToolEventBreadcrumb).ownerSessionId !== filter.sessionId) {
        return false;
      }
    }
  }

  // Child session ID — delegation child or child-owned tool events
  if (filter.childSessionId !== undefined) {
    if (breadcrumb.eventFamily === "delegation") {
      if ((breadcrumb as DelegationLifecycleBreadcrumb).childSessionId !== filter.childSessionId) {
        return false;
      }
    } else if (breadcrumb.eventFamily === "tool") {
      if ((breadcrumb as ToolEventBreadcrumb).ownerSessionId !== filter.childSessionId) {
        return false;
      }
    } else {
      return false;
    }
  }

  // Tool call ID — tool events only
  if (filter.toolCallId !== undefined) {
    if (breadcrumb.eventFamily !== "tool") return false;
    if ((breadcrumb as ToolEventBreadcrumb).toolCallId !== filter.toolCallId) {
      return false;
    }
  }

  // Grouping key
  if (filter.groupingKey !== undefined) {
    const key = computeGroupingKey(breadcrumb);
    if (key !== filter.groupingKey) return false;
  }

  return true;
}

/**
 * Compute the grouping key for a breadcrumb (matches plan doc format).
 */
function computeGroupingKey(breadcrumb: AgentWorkBreadcrumb): string {
  if (breadcrumb.eventFamily === "parent") {
    const p = breadcrumb as ParentLifecycleBreadcrumb;
    const correlationId = p.deliveryRequestId ?? p.sessionId;
    return `pi-crew-agent:${p.agentIdentity}:${correlationId}`;
  }
  if (breadcrumb.eventFamily === "delegation") {
    const d = breadcrumb as DelegationLifecycleBreadcrumb;
    return `pi-crew-delegation:${d.childSessionId}`;
  }
  // Tool events group with their owner session
  const t = breadcrumb as ToolEventBreadcrumb;
  return `pi-crew-tool:${t.ownerSessionId}:${t.toolCallId}`;
}

/**
 * Apply partial updates to a breadcrumb, returning a new object.
 */
function applyUpdates(
  existing: AgentWorkBreadcrumb,
  updates: BreadcrumbUpdateFields,
): AgentWorkBreadcrumb {
  // Build the updated object by merging non-undefined update fields
  const merged: Record<string, unknown> = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged as unknown as AgentWorkBreadcrumb;
}
