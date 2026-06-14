/** SQLite agent-work breadcrumb repository. */
import type Database from "better-sqlite3";
import type {
  AgentWorkBreadcrumb,
  AgentWorkBreadcrumbRepository,
  BreadcrumbCorrelationFilter,
  BreadcrumbUpdateFields,
} from "@pi-crew/core";
import {
  delegationGroupingKey,
  parentGroupingKey,
} from "@pi-crew/core";

interface BreadcrumbRow {
  readonly id: string;
  readonly row_json: string;
}

/** Durable SQLite implementation for structured agent-work breadcrumb rows. */
export class SqliteAgentWorkBreadcrumbRepository implements AgentWorkBreadcrumbRepository {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  append(breadcrumb: AgentWorkBreadcrumb): Promise<AgentWorkBreadcrumb> {
    const groupingKey = groupingKeyFor(breadcrumb);
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO agent_work_breadcrumbs (
        id, project_id, channel_id, source, event_type, event_family, state, severity,
        summary, evidence_json, metadata_json, grouping_key, session_id, child_session_id,
        tool_call_id, row_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      breadcrumb.id,
      breadcrumb.projectId,
      breadcrumb.channelId,
      breadcrumb.source,
      breadcrumb.eventType,
      breadcrumb.eventFamily,
      breadcrumb.state,
      breadcrumb.severity,
      breadcrumb.summary,
      JSON.stringify(breadcrumb.evidence),
      JSON.stringify(breadcrumb.metadata),
      groupingKey,
      sessionIdFor(breadcrumb),
      childSessionIdFor(breadcrumb),
      toolCallIdFor(breadcrumb),
      JSON.stringify(breadcrumb),
      breadcrumb.createdAt,
      now,
    );
    return Promise.resolve(breadcrumb);
  }

  getById(id: string): Promise<AgentWorkBreadcrumb | null> {
    const row = this.#db.prepare("SELECT id, row_json FROM agent_work_breadcrumbs WHERE id = ?")
      .get(id) as BreadcrumbRow | undefined;
    return Promise.resolve(row === undefined ? null : parseBreadcrumb(row));
  }

  updateById(id: string, updates: BreadcrumbUpdateFields): Promise<AgentWorkBreadcrumb | null> {
    const existing = this.getSync(id);
    if (existing === null) return Promise.resolve(null);
    return this.replace(existing, applyUpdates(existing, updates));
  }

  updateByCorrelation(
    filter: BreadcrumbCorrelationFilter,
    updates: BreadcrumbUpdateFields,
  ): Promise<AgentWorkBreadcrumb | null> {
    const row = this.findRow(filter);
    if (row === null) return Promise.resolve(null);
    const existing = parseBreadcrumb(row);
    return this.replace(existing, applyUpdates(existing, updates));
  }

  queryByCorrelation(filter: BreadcrumbCorrelationFilter): Promise<AgentWorkBreadcrumb[]> {
    const { where, params } = whereFor(filter);
    const rows = this.#db.prepare(`
      SELECT id, row_json FROM agent_work_breadcrumbs ${where}
      ORDER BY created_at ASC, id ASC
      LIMIT 500
    `).all(...params) as BreadcrumbRow[];
    return Promise.resolve(rows.map(parseBreadcrumb));
  }

  deleteById(id: string): Promise<void> {
    this.#db.prepare("DELETE FROM agent_work_breadcrumbs WHERE id = ?").run(id);
    return Promise.resolve();
  }

  getSync(id: string): AgentWorkBreadcrumb | null {
    const row = this.#db.prepare("SELECT id, row_json FROM agent_work_breadcrumbs WHERE id = ?")
      .get(id) as BreadcrumbRow | undefined;
    return row === undefined ? null : parseBreadcrumb(row);
  }

  private findRow(filter: BreadcrumbCorrelationFilter): BreadcrumbRow | null {
    const { where, params } = whereFor(filter);
    const row = this.#db.prepare(`
      SELECT id, row_json FROM agent_work_breadcrumbs ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(...params) as BreadcrumbRow | undefined;
    return row ?? null;
  }

  private replace(
    previous: AgentWorkBreadcrumb,
    next: AgentWorkBreadcrumb,
  ): Promise<AgentWorkBreadcrumb> {
    const groupingKey = groupingKeyFor(next);
    this.#db.prepare(`
      UPDATE agent_work_breadcrumbs
      SET event_type = ?, event_family = ?, state = ?, severity = ?, summary = ?,
          evidence_json = ?, metadata_json = ?, grouping_key = ?, session_id = ?,
          child_session_id = ?, tool_call_id = ?, row_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.eventType,
      next.eventFamily,
      next.state,
      next.severity,
      next.summary,
      JSON.stringify(next.evidence),
      JSON.stringify(next.metadata),
      groupingKey,
      sessionIdFor(next),
      childSessionIdFor(next),
      toolCallIdFor(next),
      JSON.stringify(next),
      new Date().toISOString(),
      previous.id,
    );
    return Promise.resolve(next);
  }
}

function parseBreadcrumb(row: BreadcrumbRow): AgentWorkBreadcrumb {
  return JSON.parse(row.row_json) as AgentWorkBreadcrumb;
}

function groupingKeyFor(breadcrumb: AgentWorkBreadcrumb): string {
  if (breadcrumb.eventFamily === "parent") return parentGroupingKey(breadcrumb);
  if (breadcrumb.eventFamily === "delegation") return delegationGroupingKey(breadcrumb);
  return `pi-crew-tool:${breadcrumb.ownerSessionId}:${breadcrumb.toolCallId}`;
}

function sessionIdFor(breadcrumb: AgentWorkBreadcrumb): string | null {
  if (breadcrumb.eventFamily === "parent") return breadcrumb.sessionId;
  if (breadcrumb.eventFamily === "delegation") return breadcrumb.parentSessionId;
  return breadcrumb.ownerSessionId;
}

function childSessionIdFor(breadcrumb: AgentWorkBreadcrumb): string | null {
  if ("childSessionId" in breadcrumb) return breadcrumb.childSessionId;
  if (breadcrumb.eventFamily === "tool") return breadcrumb.ownerSessionId;
  return null;
}

function toolCallIdFor(breadcrumb: AgentWorkBreadcrumb): string | null {
  return "toolCallId" in breadcrumb ? breadcrumb.toolCallId : null;
}

function applyUpdates(
  breadcrumb: AgentWorkBreadcrumb,
  updates: BreadcrumbUpdateFields,
): AgentWorkBreadcrumb {
  return { ...breadcrumb, ...updates } as AgentWorkBreadcrumb;
}

function whereFor(filter: BreadcrumbCorrelationFilter): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  add(clauses, params, "event_family", filter.eventFamily);
  add(clauses, params, "session_id", filter.sessionId);
  add(clauses, params, "child_session_id", filter.childSessionId);
  add(clauses, params, "tool_call_id", filter.toolCallId);
  add(clauses, params, "project_id", filter.projectId);
  add(clauses, params, "channel_id", filter.channelId);
  add(clauses, params, "event_type", filter.eventType);
  add(clauses, params, "grouping_key", filter.groupingKey);
  return { where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

function add(clauses: string[], params: unknown[], column: string, value: unknown): void {
  if (value === undefined) return;
  clauses.push(`${column} = ?`);
  params.push(value);
}
