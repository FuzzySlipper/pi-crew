/** Parent full-agent lifecycle breadcrumb extension. */
import type {
  AgentWorkBreadcrumbRepository,
  EventPayload,
  Logger,
} from "@pi-crew/core";
import { createParentBreadcrumb, createToolBreadcrumb } from "@pi-crew/core";
import type { ServiceExtension, ServiceExtensionContext } from "../extension-activator.js";

export interface ParentBreadcrumbBinding {
  readonly sessionId: string;
  readonly channelId: string;
  readonly projectId: string;
  readonly agentIdentity: string;
  readonly profileId: string;
  readonly provider?: string;
  readonly model?: string;
}

interface ParentBreadcrumbExtensionConfig {
  readonly repository: AgentWorkBreadcrumbRepository;
  readonly bindings: readonly ParentBreadcrumbBinding[];
  readonly logger?: Logger;
}

/** Emits structured rows for durable full-agent parent turns and tools. */
export class ParentLifecycleBreadcrumbExtension implements ServiceExtension {
  readonly id = "parent-lifecycle-breadcrumbs";
  readonly description = "Persists structured full-agent parent lifecycle breadcrumbs.";
  readonly #repository: AgentWorkBreadcrumbRepository;
  readonly #bindings: ReadonlyMap<string, ParentBreadcrumbBinding>;
  readonly #unsubscribers: Array<() => void> = [];
  readonly #logger: Logger | null;

  constructor(config: ParentBreadcrumbExtensionConfig) {
    this.#repository = config.repository;
    this.#bindings = new Map(config.bindings.map((binding) => [binding.sessionId, binding]));
    this.#logger = config.logger ?? null;
  }

  activate(context: ServiceExtensionContext): Promise<void> {
    this.#unsubscribers.push(
      context.eventBus.on("session.routing", (payload) => this.recordRouting(payload)),
      context.eventBus.on("turn.started", (payload) => this.recordTurnStarted(payload)),
      context.eventBus.on("turn.completed", (payload) => this.recordTurnCompleted(payload)),
      context.eventBus.on("turn.errored", (payload) => this.recordTurnErrored(payload)),
      context.eventBus.on("tool.called", (payload) => this.recordToolCalled(payload)),
      context.eventBus.on("tool.completed", (payload) => this.recordToolCompleted(payload)),
      context.eventBus.on("tool.denied", (payload) => this.recordToolDenied(payload)),
      context.eventBus.on("message.completed", (payload) => this.recordMessageCompleted(payload)),
    );
    return Promise.resolve();
  }

  deactivate(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    return Promise.resolve();
  }

  private recordRouting(payload: EventPayload<"session.routing">): void {
    const binding = this.binding(payload.sessionId);
    if (binding === null) return;
    this.appendParent(binding, "pi_crew.parent.runtime_received", "started", "info", {
      summary: `Full agent routed: ${payload.sessionId}`,
      metadata: { reason: payload.reason },
    });
    this.appendParent(binding, "pi_crew.parent.request_claimed", "started", "info", {
      summary: `Full agent claimed request: ${payload.sessionId}`,
      metadata: { reason: payload.reason },
    });
  }

  private recordTurnStarted(payload: EventPayload<"turn.started">): void {
    const binding = this.binding(payload.sessionId);
    if (binding === null) return;
    this.appendParent(binding, "pi_crew.parent.turn_started", "started", "info", {
      summary: `Full agent turn started: ${payload.sessionId} #${String(payload.turnNumber)}`,
      turnId: payload.turnNumber,
    });
  }

  private recordTurnCompleted(payload: EventPayload<"turn.completed">): void {
    const binding = this.binding(payload.sessionId);
    if (binding === null) return;
    this.appendParent(binding, "pi_crew.parent.completed", "completed", "info", {
      summary: `Full agent turn completed: ${payload.sessionId} #${String(payload.turnNumber)}`,
      turnId: payload.turnNumber,
      metadata: { durationMs: payload.durationMs },
    });
  }

  private recordTurnErrored(payload: EventPayload<"turn.errored">): void {
    const binding = this.binding(payload.sessionId);
    if (binding === null) return;
    this.appendParent(binding, "pi_crew.parent.failed", "failed", "error", {
      summary: `Full agent turn failed: ${payload.sessionId} #${String(payload.turnNumber)}`,
      turnId: payload.turnNumber,
      metadata: { error: payload.error },
    });
  }

  private recordMessageCompleted(payload: EventPayload<"message.completed">): void {
    if (payload.messageRole !== "assistant") return;
    const binding = this.binding(payload.sessionId);
    if (binding === null) return;
    this.appendParent(binding, "pi_crew.parent.completed", "completed", "info", {
      summary: `Full agent assistant message completed: ${payload.sessionId}`,
      metadata: { messageRole: payload.messageRole },
    });
  }

  private recordToolCalled(payload: EventPayload<"tool.called">): void {
    const binding = this.binding(payload.sessionId);
    if (binding === null) return;
    const toolCallId = parentToolCallId(payload.sessionId, payload.toolName);
    void this.#repository.append(createToolBreadcrumb({
      projectId: binding.projectId,
      channelId: binding.channelId,
      eventFamily: "tool",
      eventType: "pi_crew.parent.tool_called",
      state: "interim",
      severity: "debug",
      summary: `Full agent tool called: ${payload.toolName}`,
      evidence: { sessionId: payload.sessionId, toolName: payload.toolName },
      metadata: { agentIdentity: binding.agentIdentity, profileId: binding.profileId },
      toolName: payload.toolName,
      toolCallId,
      phase: "called",
      isError: false,
      resultClass: "ok",
      ownerSessionId: payload.sessionId,
    })).catch((error: unknown) => this.logFailure(error));
  }

  private recordToolCompleted(payload: EventPayload<"tool.completed">): void {
    const binding = this.binding(payload.sessionId);
    if (binding === null) return;
    const toolCallId = parentToolCallId(payload.sessionId, payload.toolName);
    void this.#repository.updateByCorrelation(
      { eventFamily: "tool", sessionId: payload.sessionId, toolCallId },
      {
        state: payload.success ? "completed" : "failed",
        summary: `Full agent tool completed: ${payload.toolName}`,
        phase: payload.success ? "completed" : "failed",
        durationMs: payload.durationMs,
        isError: !payload.success,
        resultClass: payload.success ? "ok" : "error",
      },
    ).then((updated) => updated ?? this.#repository.append(createToolBreadcrumb({
      projectId: binding.projectId,
      channelId: binding.channelId,
      eventFamily: "tool",
      eventType: "pi_crew.parent.tool_completed",
      state: payload.success ? "completed" : "failed",
      severity: payload.success ? "debug" : "warn",
      summary: `Full agent tool completed: ${payload.toolName}`,
      evidence: { sessionId: payload.sessionId, toolName: payload.toolName },
      metadata: { agentIdentity: binding.agentIdentity, profileId: binding.profileId },
      toolName: payload.toolName,
      toolCallId,
      phase: payload.success ? "completed" : "failed",
      durationMs: payload.durationMs,
      isError: !payload.success,
      resultClass: payload.success ? "ok" : "error",
      ownerSessionId: payload.sessionId,
    }))).catch((error: unknown) => this.logFailure(error));
  }

  private recordToolDenied(payload: EventPayload<"tool.denied">): void {
    const binding = this.binding(payload.sessionId);
    if (binding === null) return;
    void this.#repository.append(createToolBreadcrumb({
      projectId: binding.projectId,
      channelId: binding.channelId,
      eventFamily: "tool",
      eventType: "pi_crew.parent.tool_completed",
      state: "denied",
      severity: "warn",
      summary: `Full agent tool denied: ${payload.toolName}`,
      evidence: { sessionId: payload.sessionId, toolName: payload.toolName },
      metadata: { agentIdentity: binding.agentIdentity, profileId: binding.profileId, reason: payload.reason },
      toolName: payload.toolName,
      toolCallId: parentToolCallId(payload.sessionId, payload.toolName),
      phase: "denied",
      isError: true,
      resultClass: "denied",
      ownerSessionId: payload.sessionId,
    })).catch((error: unknown) => this.logFailure(error));
  }

  private appendParent(
    binding: ParentBreadcrumbBinding,
    eventType: "pi_crew.parent.runtime_received" | "pi_crew.parent.request_claimed" |
      "pi_crew.parent.turn_started" | "pi_crew.parent.completed" | "pi_crew.parent.failed",
    state: "started" | "completed" | "failed",
    severity: "info" | "error",
    input: { readonly summary: string; readonly metadata?: Record<string, unknown>; readonly turnId?: number },
  ): void {
    void this.#repository.append(createParentBreadcrumb({
      projectId: binding.projectId,
      channelId: binding.channelId,
      eventFamily: "parent",
      eventType,
      state,
      severity,
      summary: input.summary,
      evidence: { sessionId: binding.sessionId },
      metadata: input.metadata ?? {},
      agentIdentity: binding.agentIdentity,
      profileId: binding.profileId,
      sessionId: binding.sessionId,
      provider: binding.provider,
      model: binding.model,
      turnId: input.turnId,
    })).catch((error: unknown) => this.logFailure(error));
  }

  private binding(sessionId: string): ParentBreadcrumbBinding | null {
    return this.#bindings.get(sessionId) ?? null;
  }

  private logFailure(error: unknown): void {
    this.#logger?.warn("parent.breadcrumb.persist_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parentToolCallId(sessionId: string, toolName: string): string {
  return `${sessionId}:${toolName}`;
}
