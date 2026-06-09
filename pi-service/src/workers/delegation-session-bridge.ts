/** Concrete DelegationSessionBridge backed by SessionManager and SessionStore. */

import type {
  DelegationLineage,
  DelegationSpawnRequest,
  EventBus,
  ExecutionPolicy,
  Logger,
} from "@pi-crew/core";
import { createChildDelegationLineage } from "@pi-crew/core";
import type {
  DelegatedSessionCreateRequest,
  DelegationSessionBridge,
  DelegationVisibilityEvent,
  ServiceSessionView,
} from "../extension-activator.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { SessionRecord } from "../sessions/types.js";

export interface SessionManagerDelegationBridgeConfig {
  readonly sessionManager: SessionManager;
  readonly sessionStore: SessionStore;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class SessionManagerDelegationSessionBridge implements DelegationSessionBridge {
  readonly #sessionManager: SessionManager;
  readonly #sessionStore: SessionStore;
  readonly #logger: Logger;
  readonly #policies = new Map<string, ExecutionPolicy>();

  constructor(config: SessionManagerDelegationBridgeConfig) {
    this.#sessionManager = config.sessionManager;
    this.#sessionStore = config.sessionStore;
    this.#logger = config.logger;
  }

  async getSession(sessionId: string): Promise<ServiceSessionView | null> {
    const record = await this.#sessionManager.get(sessionId);
    return record === null ? null : toView(record);
  }

  async createDelegatedSession(
    request: DelegatedSessionCreateRequest,
  ): Promise<ServiceSessionView> {
    const sessionId = request.sessionId ?? `delegated-${String(Date.now())}`;
    const lineage = readLineage(request.visibility);
    const spawnRequest = readSpawnRequest(request.visibility);
    const record = await this.#sessionManager.create({
      sessionId,
      profileId: request.profileId,
      kind: "delegated",
      delegation: lineage ?? fallbackLineage(request.parentSessionId, sessionId),
      delegationSpawnRequest: spawnRequest ?? { task: "delegated child task" },
      delegationConstraints: request.delegationConstraints,
      effectiveRuntime: request.effectiveRuntime,
    });
    this.#policies.set(record.id, request.policy);
    this.#logger.info("Delegated session created", {
      sessionId: record.id,
      parentSessionId: request.parentSessionId,
      profileId: request.profileId,
    });
    return toView(record);
  }

  async listChildSessions(parentSessionId: string): Promise<readonly ServiceSessionView[]> {
    const active = await this.#sessionStore.findByState("active");
    const idle = await this.#sessionStore.findByState("idle");
    return [...active, ...idle]
      .filter((record) => record.delegation?.parentSessionId === parentSessionId)
      .map(toView);
  }

  async countChildSessions(parentSessionId: string): Promise<number> {
    return (await this.listChildSessions(parentSessionId)).length;
  }

  getParentExecutionPolicy(childSessionId: string): Promise<ExecutionPolicy | null> {
    return Promise.resolve(this.#policies.get(childSessionId) ?? null);
  }

  async releaseChildSession(childSessionId: string, reason: string): Promise<void> {
    const record = await this.#sessionManager.get(childSessionId);
    if (record === null) return;
    await this.#sessionStore.save({
      ...record,
      state: "idle",
      lastActiveAt: new Date().toISOString(),
    });
    this.#logger.info("Delegated session released", { childSessionId, reason });
  }

  async killChildSession(childSessionId: string, reason: string): Promise<void> {
    const record = await this.#sessionManager.get(childSessionId);
    if (record !== null && record.delegation !== null) {
      await this.#sessionStore.save({
        ...record,
        lastActiveAt: new Date().toISOString(),
      });
    }
    this.#logger.warn("Delegated session killed", { childSessionId, reason });
  }

  async archiveChildSession(childSessionId: string, reason: string): Promise<void> {
    await this.#sessionManager.archive(childSessionId);
    this.#policies.delete(childSessionId);
    this.#logger.info("Delegated session archived", { childSessionId, reason });
  }

  emitVisibilityEvent(event: DelegationVisibilityEvent): Promise<void> {
    this.#logger.debug("Delegated visibility event", {
      sessionId: event.sessionId,
      eventType: event.eventType,
    });
    return Promise.resolve();
  }
}

function toView(record: SessionRecord): ServiceSessionView {
  return {
    sessionId: record.id,
    profileId: record.profileId,
    kind: record.kind,
    state: record.state,
    parentSessionId: record.delegation?.parentSessionId ?? null,
    rootSessionId: record.delegation?.rootSessionId ?? record.id,
    lastActiveAt: record.lastActiveAt,
  };
}

function readLineage(
  value: Readonly<Record<string, unknown>> | undefined,
): DelegationLineage | undefined {
  const lineage = value?.["lineage"];
  if (typeof lineage !== "object" || lineage === null) return undefined;
  return lineage as DelegationLineage;
}

function readSpawnRequest(
  value: Readonly<Record<string, unknown>> | undefined,
): DelegationSpawnRequest | undefined {
  const spawnRequest = value?.["spawnRequest"];
  if (typeof spawnRequest !== "object" || spawnRequest === null) return undefined;
  return spawnRequest as DelegationSpawnRequest;
}

function fallbackLineage(parentSessionId: string, childSessionId: string): DelegationLineage {
  return createChildDelegationLineage({
    parentSessionId,
    childSessionId,
  });
}
