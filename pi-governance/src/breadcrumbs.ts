/**
 * BreadcrumbManager — subscribes to the event bus and emits
 * structured breadcrumbs on the governance channel via ChannelProvider.
 *
 * Breadcrumbs are never injected into agent context. They are a
 * separate governance channel for human situational awareness.
 *
 * @module pi-governance/breadcrumbs
 */

import type {
  EventBus,
  ChannelProvider,
  ChannelBreadcrumb,
  Logger,
  ToolCalledPayload,
  ToolCompletedPayload,
  AssignmentClaimedPayload,
  TurnStartedPayload,
  TurnCompletedPayload,
  BlackboardWrittenPayload,
} from "@pi-crew/core";

// ── Category helpers ────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, string> = {
  tool: "🔧",
  worker: "👷",
  turn: "🔄",
  memory: "📝",
  system: "⚙️",
};

/** Derive a breadcrumb category from an event name. */
function categoryFor(event: string): string {
  if (event.startsWith("tool.")) return "tool";
  if (event.startsWith("assignment.")) return "worker";
  if (event.startsWith("turn.")) return "turn";
  if (event.startsWith("blackboard.")) return "memory";
  return "system";
}

/** Format a breadcrumb description as: `[icon] description`. */
function formatDescription(category: string, description: string): string {
  const icon = CATEGORY_ICONS[category] ?? "•";
  return `${icon} ${description}`;
}

// ── BreadcrumbManager ───────────────────────────────────────────

/**
 * Subscribes to lifecycle events and emits governance breadcrumbs.
 *
 * Supports lifecycle updates: a breadcrumb emitted with status
 * `"started"` or `"in_progress"` can be updated to `"completed"`
 * or `"failed"` via `updateBreadcrumb` on the provider.
 */
export class BreadcrumbManager {
  /**
   * Track in-progress breadcrumbs by a semantic key so we can
   * update them when the lifecycle event completes.
   */
  private readonly activeKeys = new Map<string, string>();

  private readonly unsubscribeFns: Array<() => void> = [];

  constructor(
    private readonly eventBus: EventBus,
    private readonly channelProvider: ChannelProvider,
    private readonly logger: Logger,
  ) {
    this.subscribe();
  }

  // ── Subscription setup ──────────────────────────────────────

  private subscribe(): void {
    this.unsubscribeFns.push(
      this.eventBus.on("tool.called", (p) => {
        void this.handleToolCalled(p);
      }),
      this.eventBus.on("tool.completed", (p) => {
        void this.handleToolCompleted(p);
      }),
      this.eventBus.on("assignment.claimed", (p) => {
        void this.handleAssignmentClaimed(p);
      }),
      this.eventBus.on("turn.started", (p) => {
        void this.handleTurnStarted(p);
      }),
      this.eventBus.on("turn.completed", (p) => {
        void this.handleTurnCompleted(p);
      }),
      this.eventBus.on("blackboard.written", (p) => {
        void this.handleBlackboardWritten(p);
      }),
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** Unsubscribe from all events. Call during shutdown. */
  dispose(): void {
    for (const unsub of this.unsubscribeFns) {
      unsub();
    }
    this.unsubscribeFns.length = 0;
    this.activeKeys.clear();
  }

  // ── Event handlers ───────────────────────────────────────────

  private async handleToolCalled(payload: ToolCalledPayload): Promise<void> {
    const key = `tool:${payload.toolName}:${payload.sessionId}`;
    const desc = `Called ${payload.toolName}`;
    await this.startBreadcrumb(key, "tool", desc);
  }

  private async handleToolCompleted(payload: ToolCompletedPayload): Promise<void> {
    const key = `tool:${payload.toolName}:${payload.sessionId}`;
    if (payload.success) {
      const desc = `${payload.toolName} completed (${String(payload.durationMs)}ms)`;
      await this.finishBreadcrumb(key, "completed", desc);
    } else {
      const desc = `${payload.toolName} failed (${String(payload.durationMs)}ms)`;
      await this.finishBreadcrumb(key, "failed", desc);
    }
  }

  private async handleAssignmentClaimed(payload: AssignmentClaimedPayload): Promise<void> {
    const desc = `Worker ${payload.workerIdentity} claimed assignment #${String(payload.assignmentId)} (task #${String(payload.taskId)})`;
    await this.emitBreadcrumb("worker", "completed", desc);
  }

  private async handleTurnStarted(payload: TurnStartedPayload): Promise<void> {
    const key = `turn:${payload.sessionId}:${String(payload.turnNumber)}`;
    const desc = `Turn ${String(payload.turnNumber)} started`;
    await this.startBreadcrumb(key, "turn", desc);
  }

  private async handleTurnCompleted(payload: TurnCompletedPayload): Promise<void> {
    const key = `turn:${payload.sessionId}:${String(payload.turnNumber)}`;
    const desc = `Turn ${String(payload.turnNumber)} completed (${String(payload.durationMs)}ms)`;
    await this.finishBreadcrumb(key, "completed", desc);
  }

  // DESIGN: `blackboard.written` remains subscribed only as deferred
  // future-compatible plumbing. Rationale: Den docs
  // `planning-clarifications-v1` and `submodule-architecture` declare
  // pi-memory/blackboard deferred, with Den authoritative for workflow state.
  private async handleBlackboardWritten(payload: BlackboardWrittenPayload): Promise<void> {
    const desc = `Entry ${payload.entryId} written (session ${payload.sessionId})`;
    await this.emitBreadcrumb("memory", "completed", desc);
  }

  // ── Breadcrumb emission helpers ──────────────────────────────

  private async emitBreadcrumb(
    category: string,
    status: ChannelBreadcrumb["status"],
    description: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const breadcrumb: ChannelBreadcrumb = {
      id: crypto.randomUUID(),
      channelId: "governance",
      category,
      status,
      description: formatDescription(category, description),
      metadata,
    };
    try {
      await this.channelProvider.sendBreadcrumb(breadcrumb);
      this.logger.debug("Breadcrumb sent", {
        id: breadcrumb.id,
        category,
        status,
      });
    } catch (err: unknown) {
      this.logger.error("Failed to send breadcrumb", {
        category,
        status,
        error: String(err),
      });
    }
    return breadcrumb.id;
  }

  private async startBreadcrumb(key: string, category: string, description: string): Promise<void> {
    const id = await this.emitBreadcrumb(category, "started", description);
    this.activeKeys.set(key, id);
  }

  private async finishBreadcrumb(
    key: string,
    status: "completed" | "failed",
    description: string,
  ): Promise<void> {
    const existingId = this.activeKeys.get(key);
    if (existingId) {
      try {
        await this.channelProvider.updateBreadcrumb(existingId, {
          status,
          description: formatDescription(categoryFor(key), description),
        });
        this.activeKeys.delete(key);
      } catch (err: unknown) {
        this.logger.error("Failed to update breadcrumb", {
          breadcrumbId: existingId,
          status,
          error: String(err),
        });
      }
    } else {
      // No previous breadcrumb — emit a standalone one
      await this.emitBreadcrumb(categoryFor(key), status, description);
    }
  }
}
