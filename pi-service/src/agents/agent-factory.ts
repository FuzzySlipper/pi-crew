/**
 * AgentFactory — creates configured agent/session instances.
 *
 * Takes a {@link SessionConfig} and produces a ready-to-use session
 * paired with an agent instance.  Handles skill loading and system
 * prompt assembly without modifying pi-agent-core internals.
 *
 * @module pi-service/agents/agent-factory
 */

import type { Logger, EventBus } from "@pi-crew/core";
import type {
  SessionConfig,
  SessionRecord,
} from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { InstancePool } from "../instances/instance-pool.js";

// ── AgentFactory interface ──────────────────────────────────────

/**
 * Creates sessions paired with agent instances.
 *
 * Each call to {@link createSession} produces a new {@link SessionRecord}
 * persisted to the session store, with a live instance in the pool.
 */
export interface AgentFactory {
  /**
   * Create a new conversational or worker session.
   *
   * @param config — Session configuration (profile, kind, bindings).
   * @returns The persisted session record.
   */
  createSession(config: SessionConfig): Promise<SessionRecord>;
}

// ── AgentFactory implementation ────────────────────────────────

/**
 * Default {@link AgentFactory} implementation.
 *
 * Creates a session record, acquires an instance from the pool,
 * stores the record, and emits a `session.created` event.
 */
export class AgentFactoryImpl implements AgentFactory {
  constructor(
    private readonly pool: InstancePool,
    private readonly store: SessionStore,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
  ) {}

  async createSession(config: SessionConfig): Promise<SessionRecord> {
    const instance = await this.pool.acquire(
      config.profileId,
      config.workerBinding?.role,
      config.effectiveRuntime,
    );

    const now = new Date().toISOString();

    const record: SessionRecord = {
      id: config.sessionId ?? `sess-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
      profileId: config.profileId,
      instanceId: instance.id,
      kind: config.kind,
      delegation: config.delegation ?? null,
      delegationSpawnRequest: config.delegationSpawnRequest ?? null,
      delegationConstraints: config.delegationConstraints ?? null,
      effectiveRuntime: config.effectiveRuntime ?? null,
      createdAt: now,
      lastActiveAt: now,
      state: "active",
      messageCount: 0,
      channelBindings: config.kind === "conversational" ? config.channelBindings ?? [] : [],
      workerBinding: config.kind === "worker" ? config.workerBinding ?? null : null,
    };

    await this.store.save(record);

    this.eventBus.emit({
      event: "session.created",
      payload: {
        sessionId: record.id,
        kind: record.kind,
        ...(record.delegation ? { delegation: record.delegation } : {}),
      },
    });

    this.logger.info("Session created", {
      sessionId: record.id,
      kind: record.kind,
      profileId: record.profileId,
    });

    return record;
  }
}
