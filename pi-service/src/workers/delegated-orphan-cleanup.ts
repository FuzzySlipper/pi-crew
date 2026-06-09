/** Delegated child orphan cleanup and evidence emission. */

import type {
  DelegationLineage,
  EventBus,
  ExecutionPolicy,
  GatewayEvent,
  Logger,
} from "@pi-crew/core";
import type {
  DelegationSessionBridge,
  DelegationVisibilityEvent,
  ServiceSessionView,
} from "../extension-activator.js";

export interface DelegatedOrphanCleanupConfig {
  readonly delegationSessions: DelegationSessionBridge;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface DelegatedParentCleanupRequest {
  readonly parentSessionId: string;
  readonly reason: string;
  readonly initiatedBy: "parent" | "orphan_detected";
}

export interface DelegatedParentCleanupEvidence {
  readonly parentSessionId: string;
  readonly reason: string;
  readonly cleanedChildSessionIds: readonly string[];
  readonly orphanDetectedCount: number;
  readonly killedCount: number;
}

export class DelegatedOrphanCleanup {
  readonly #bridge: DelegationSessionBridge;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #now: () => number;
  #unsubscribeSessionExpired: (() => void) | null = null;

  constructor(config: DelegatedOrphanCleanupConfig) {
    this.#bridge = config.delegationSessions;
    this.#eventBus = config.eventBus;
    this.#logger = config.logger;
    this.#now = config.now ?? Date.now;
  }

  activate(): void {
    if (this.#unsubscribeSessionExpired !== null) return;
    this.#unsubscribeSessionExpired = this.#eventBus.on("session.expired", (payload) => {
      void this.cleanupChildrenForParent({
        parentSessionId: payload.sessionId,
        reason: payload.reason,
        initiatedBy: "orphan_detected",
      });
    });
  }

  deactivate(): void {
    this.#unsubscribeSessionExpired?.();
    this.#unsubscribeSessionExpired = null;
  }

  async cleanupChildrenForParent(
    request: DelegatedParentCleanupRequest,
  ): Promise<DelegatedParentCleanupEvidence> {
    const children = await this.#bridge.listChildSessions(request.parentSessionId);
    const cleaned: string[] = [];
    let orphanDetectedCount = 0;
    let killedCount = 0;

    for (const child of children) {
      const policy = await this.#bridge.getParentExecutionPolicy(child.sessionId);
      const lineage = lineageFromChild(child, request.parentSessionId);
      await this.emitOrphanDetected({ child, lineage, policy, request });
      orphanDetectedCount += 1;
      await this.#bridge.killChildSession(child.sessionId, request.reason);
      await this.emitKilled({ child, lineage, policy, request });
      killedCount += 1;
      await this.#bridge.archiveChildSession(child.sessionId, request.reason);
      cleaned.push(child.sessionId);
    }

    this.#logger.warn("Delegated children cleaned after parent lifecycle transition", {
      parentSessionId: request.parentSessionId,
      reason: request.reason,
      cleanedChildSessionIds: cleaned,
    });

    return {
      parentSessionId: request.parentSessionId,
      reason: request.reason,
      cleanedChildSessionIds: cleaned,
      orphanDetectedCount,
      killedCount,
    };
  }

  private async emitOrphanDetected(input: CleanupEventInput): Promise<void> {
    const payload = {
      ...correlation(input.policy),
      orphanSessionId: input.child.sessionId,
      lastKnownParentSessionId: input.request.parentSessionId,
      idleDurationMs: idleDurationMs(input.child.lastActiveAt, this.#now()),
      lineage: input.lineage,
      policyId: input.policy?.policyId ?? "unknown",
    };
    this.#eventBus.emit({ event: "delegation.orphan_detected", payload } satisfies GatewayEvent);
    await this.emitVisibility("delegation.orphan_detected", input.child.sessionId, payload);
  }

  private async emitKilled(input: CleanupEventInput): Promise<void> {
    const payload = {
      ...correlation(input.policy),
      childSessionId: input.child.sessionId,
      lineage: input.lineage,
      policyId: input.policy?.policyId ?? "unknown",
      reason: input.request.reason,
      initiatedBy: input.request.initiatedBy,
    };
    this.#eventBus.emit({ event: "delegation.killed", payload } satisfies GatewayEvent);
    await this.emitVisibility("delegation.killed", input.child.sessionId, payload);
  }

  private async emitVisibility(
    eventType: string,
    sessionId: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.#bridge.emitVisibilityEvent({
      sessionId,
      eventType,
      metadata,
    } satisfies DelegationVisibilityEvent);
  }
}

interface CleanupEventInput {
  readonly child: ServiceSessionView;
  readonly lineage: DelegationLineage;
  readonly policy: ExecutionPolicy | null;
  readonly request: DelegatedParentCleanupRequest;
}

function lineageFromChild(child: ServiceSessionView, parentSessionId: string): DelegationLineage {
  const rootSessionId = child.rootSessionId || parentSessionId;
  return {
    parentSessionId,
    rootSessionId,
    childSessionId: child.sessionId,
    depth: rootSessionId === parentSessionId ? 1 : 2,
    chain:
      rootSessionId === parentSessionId
        ? [parentSessionId, child.sessionId]
        : [rootSessionId, parentSessionId, child.sessionId],
  };
}

function idleDurationMs(lastActiveAt: string, now: number): number {
  const lastActive = Date.parse(lastActiveAt);
  if (Number.isNaN(lastActive)) return 0;
  return Math.max(0, now - lastActive);
}

function correlation(policy: ExecutionPolicy | null): Readonly<Record<string, string>> {
  if (policy === null) return {};
  return { policyId: policy.policyId };
}
