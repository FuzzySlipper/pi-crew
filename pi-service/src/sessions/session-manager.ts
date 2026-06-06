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
  ChannelContent,
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
    let record = await this.resolveSession(message.channelId);

    // ── Rehydration path for conversational sessions ──────────────
    // When a conversational session is idle (instance evicted),
    // acquire a fresh instance and re-bind it so the next message
    // is processed instead of silently dropped.
    if (record.kind === "conversational") {
      const instanceId = record.instanceId;
      const hasLiveInstance = instanceId !== null &&
        this.pool.has(instanceId);

      if (!hasLiveInstance) {
        const reason = instanceId === null
          ? "idle_session"
          : "instance_missing";
        const instance = await this.pool.acquire(record.profileId);

        const now = new Date().toISOString();
        const rehydrated: typeof record = {
          ...record,
          instanceId: instance.id,
          state: "active",
          lastActiveAt: now,
        };

        await this.store.save(rehydrated);

        this.eventBus.emit({
          event: "session.rehydrated",
          payload: {
            sessionId: record.id,
            profileId: record.profileId,
            channelId: message.channelId,
            oldInstanceId: instanceId,
            newInstanceId: instance.id,
            reason,
          },
        });

        this.logger.info("Conversational session rehydrated", {
          sessionId: record.id,
          profileId: record.profileId,
          newInstanceId: instance.id,
        });

        record = rehydrated;
      }
    }

    // Retrieve the session's agent instance and process the message.
    const instanceId = record.instanceId;
    if (!instanceId) {
      this.logger.warn("Session has no instance, cannot process message", {
        sessionId: record.id,
      });
      return;
    }

    const instance = this.pool.get(instanceId);
    if (!instance) {
      this.logger.warn("Instance not found in pool", {
        instanceId,
        sessionId: record.id,
      });
      return;
    }

    try {
      const response: ChannelContent =
        await instance.processMessage(message);

      await channel.sendMessage(message.channelId, response);

      this.logger.debug("Agent response sent", {
        sessionId: record.id,
        channelId: message.channelId,
      });
    } catch (error) {
      this.logger.error("Agent processMessage failed", {
        sessionId: record.id,
        channelId: message.channelId,
        error: (error as Error).message,
      });

      // Send an error message back to the channel.
      await channel.sendMessage(message.channelId, {
        kind: "text",
        text: `[pi-service] Agent error: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Resolve (or create) the session for a channel.
   *
   * 1. Look for an existing in-progress session bound to the channel.
   * 2. If found, route to it.
   * 3. If not found, create a new conversational session as a visible
   *    fallback (emits `session.routing` with reason `fallback_created`).
   *
   * @returns The resolved session record.
   */
  private async resolveSession(
    channelId: string,
  ): Promise<SessionRecord> {
    // 1. Look for an existing in-progress session bound to this channel.
    const existing = await this.findByChannel(channelId);

    if (existing && existing.state !== "archived") {
      // Touch the instance to prevent idle eviction.
      if (existing.instanceId) {
        this.pool.touch(existing.instanceId);
      }

      this.eventBus.emit({
        event: "session.routing",
        payload: {
          sessionId: existing.id,
          channelId,
          reason: "existing_session",
        },
      });

      this.logger.debug("Message routed to existing session", {
        sessionId: existing.id,
        channelId,
      });

      return existing;
    }

    // 2. No suitable session — create a new conversational session as
    //    a visible fallback.
    const newSession = await this.create({
      profileId: "default",
      kind: "conversational",
      channelBindings: [channelId],
    });

    this.eventBus.emit({
      event: "session.routing",
      payload: {
        sessionId: newSession.id,
        channelId,
        reason: "fallback_created",
      },
    });

    this.logger.info("Fallback session created for routing", {
      sessionId: newSession.id,
      channelId,
    });

    return newSession;
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
