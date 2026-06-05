/**
 * SessionManager — multi-session orchestrator for pi-service.
 *
 * Routes inbound messages to the correct session, creates new sessions
 * as a visible fallback, manages channel bindings, handles worker
 * session lifecycle, and enforces LRU idle-eviction.
 *
 * @module pi-service/sessions/session-manager
 */

import type {
  Logger,
  EventBus,
  ChannelProvider,
  ChannelMessage,
} from "@pi-crew/core";
import type {
  SessionConfig,
  SessionRecord,
} from "./types.js";
import type { SessionStore } from "./session-store.js";
import type { AgentFactory } from "../agents/agent-factory.js";
import type { InstancePool } from "../instances/instance-pool.js";

// ── SessionManager interface ────────────────────────────────────

/**
 * Multi-session orchestrator.
 *
 * Owns session lifecycle: creation, routing, channel binding,
 * archival, and idle eviction.
 */
export interface SessionManager {
  /**
   * Create a new conversational or worker session.
   *
   * The session record is persisted and an instance is acquired from
   * the pool.  A `session.created` event is emitted.
   *
   * @param config — Session configuration.
   * @returns The persisted session record.
   */
  create(config: SessionConfig): Promise<SessionRecord>;

  /**
   * Get a session by ID.
   *
   * Archived sessions are not returned.
   *
   * @param sessionId — Session ID.
   * @returns The session record, or null if not found or archived.
   */
  get(sessionId: string): Promise<SessionRecord | null>;

  /**
   * Find the first non-archived session bound to a channel.
   *
   * Used by routing to locate the preferred in-progress session.
   */
  findByChannel(channelId: string): Promise<SessionRecord | null>;

  /**
   * Bind a channel to a session.
   *
   * Does nothing if the channel is already bound. Conversational sessions
   * only — worker sessions have no channel bindings.
   */
  bindChannel(sessionId: string, channelId: string): Promise<void>;

  /**
   * Unbind a channel from a session.
   */
  unbindChannel(sessionId: string, channelId: string): Promise<void>;

  /**
   * Route an inbound message to the correct session.
   *
   * 1. Look for an existing in-progress session bound to the channel.
   * 2. If found, route to it.
   * 3. If not found, create a new conversational session as a visible
   *    fallback (emits `session.routing` with reason `fallback_created`).
   *
   * @param channel — The channel provider.
   * @param message — The inbound message.
   */
  routeMessage(
    channel: ChannelProvider,
    message: ChannelMessage,
  ): Promise<void>;

  /**
   * Archive a session.
   *
   * Archived sessions are excluded from `get` and `findByChannel`.
   * The instance is released from the pool.
   */
  archive(sessionId: string): Promise<void>;

  /**
   * Evict idle sessions past the configured idle timeout.
   *
   * Calls `evictIdle` on the instance pool. Sessions whose instances
   * are evicted have their state set to "idle".
   *
   * @returns Number of instances evicted.
   */
  evictIdleSessions(): Promise<number>;
}

// ── SessionManager implementation ───────────────────────────────

/**
 * Default {@link SessionManager} implementation.
 *
 * Dependencies are constructor-injected — no global singletons.
 */
export class SessionManagerImpl implements SessionManager {
  constructor(
    private readonly store: SessionStore,
    private readonly factory: AgentFactory,
    private readonly pool: InstancePool,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
  ) {}

  // ── SessionManager contract ───────────────────────────────────

  async create(config: SessionConfig): Promise<SessionRecord> {
    return this.factory.createSession(config);
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.store.get(sessionId);
  }

  async findByChannel(channelId: string): Promise<SessionRecord | null> {
    return this.store.findByChannel(channelId);
  }

  async bindChannel(
    sessionId: string,
    channelId: string,
  ): Promise<void> {
    const record = await this.store.get(sessionId);
    if (!record) return;

    if (record.kind === "worker") {
      this.logger.warn("Cannot bind channel to worker session", {
        sessionId,
        channelId,
      });
      return;
    }

    if (record.channelBindings.includes(channelId)) return;

    const updated: SessionRecord = {
      ...record,
      channelBindings: [...record.channelBindings, channelId],
    };

    await this.store.save(updated);

    this.logger.info("Channel bound to session", {
      sessionId,
      channelId,
    });
  }

  async unbindChannel(
    sessionId: string,
    channelId: string,
  ): Promise<void> {
    const record = await this.store.get(sessionId);
    if (!record) return;

    const updated: SessionRecord = {
      ...record,
      channelBindings: record.channelBindings.filter(
        (id) => id !== channelId,
      ),
    };

    await this.store.save(updated);

    this.logger.info("Channel unbound from session", {
      sessionId,
      channelId,
    });
  }

  async routeMessage(
    channel: ChannelProvider,
    message: ChannelMessage,
  ): Promise<void> {
    // 1. Look for an existing in-progress session bound to this channel.
    const existing = await this.findByChannel(message.channelId);

    if (existing && existing.state !== "archived") {
      // Touch the instance to prevent idle eviction.
      if (existing.instanceId) {
        this.pool.touch(existing.instanceId);
      }

      this.eventBus.emit({
        event: "session.routing",
        payload: {
          sessionId: existing.id,
          channelId: message.channelId,
          reason: "existing_session",
        },
      });

      this.logger.debug("Message routed to existing session", {
        sessionId: existing.id,
        channelId: message.channelId,
      });

      return;
    }

    // 2. No suitable session — create a new conversational session as
    //    a visible fallback.
    const newSession = await this.create({
      profileId: "default",
      kind: "conversational",
      channelBindings: [message.channelId],
    });

    this.eventBus.emit({
      event: "session.routing",
      payload: {
        sessionId: newSession.id,
        channelId: message.channelId,
        reason: "fallback_created",
      },
    });

    this.logger.info("Fallback session created for routing", {
      sessionId: newSession.id,
      channelId: message.channelId,
    });
  }

  async archive(sessionId: string): Promise<void> {
    const record = await this.store.get(sessionId);
    if (!record) return;

    // Release instance from pool.
    if (record.instanceId) {
      await this.pool.release(record.instanceId);
    }

    const updated: SessionRecord = {
      ...record,
      state: "archived",
      instanceId: null,
    };

    await this.store.save(updated);

    this.eventBus.emit({
      event: "session.expired",
      payload: {
        sessionId,
        reason: "archived",
      },
    });

    this.logger.info("Session archived", { sessionId });
  }

  async evictIdleSessions(): Promise<number> {
    const evictedCount = await this.pool.evictIdle();

    // Update session records for evicted instances.
    // We need to find sessions whose instance was evicted.
    // Since the pool doesn't tell us which instance IDs were evicted,
    // we sweep active sessions and check if their instance is still in pool.
    const activeSessions = await this.store.findByState("active");
    let updatedCount = 0;

    for (const record of activeSessions) {
      if (record.instanceId && !this.pool.has(record.instanceId)) {
        const updated: SessionRecord = {
          ...record,
          state: "idle",
          instanceId: null,
        };
        await this.store.save(updated);
        updatedCount += 1;
      }
    }

    if (updatedCount > 0) {
      this.logger.info("Session records marked idle after eviction", {
        updatedCount,
      });
    }

    return evictedCount;
  }
}
