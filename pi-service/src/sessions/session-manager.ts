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
  EventPayload,
  ChannelMembershipStatus,
  ChannelSubscriptionStatus,
} from "@pi-crew/core";
import type {
  SessionConfig,
  SessionRecord,
  ChannelBindingRecord,
  ChannelBinding,
} from "./types.js";
import {
  appendChannelBinding,
  channelBindingId,
  isChannelBindingRecord,
  removeChannelBinding,
} from "./session-channel-bindings.js";
import type { SessionStore } from "./session-store.js";
import type { AgentFactory } from "../agents/agent-factory.js";
import type { InstancePool } from "../instances/instance-pool.js";
import type { AgentInstance } from "../instances/agent-instance.js";
import {
  ConversationalTurnCoordinator,
  isConversationalTurnTimeoutError,
  withTurnTimeout,
  type ConversationalTurnCoordinatorOptions,
} from "./conversational-turn-coordinator.js";

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
  routeMessage(channel: ChannelProvider, message: ChannelMessage): Promise<void>;

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

/**
 * Default {@link SessionManager} implementation.
 *
 * Dependencies are constructor-injected — no global singletons.
 */
export class SessionManagerImpl implements SessionManager {
  private readonly turnCoordinator: ConversationalTurnCoordinator;

  constructor(
    private readonly store: SessionStore,
    private readonly factory: AgentFactory,
    private readonly pool: InstancePool,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    private readonly fallbackProfileId: string,
    private readonly fallbackBinding: ((channelId: string) => ChannelBinding) | null = null,
    turnOptions: ConversationalTurnCoordinatorOptions = {},
  ) {
    this.turnCoordinator = new ConversationalTurnCoordinator(turnOptions);
  }

  async create(config: SessionConfig): Promise<SessionRecord> {
    const record = await this.factory.createSession(config);
    this.emitPresence(record, "created", "active", "active");
    return record;
  }
  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.store.get(sessionId);
  }
  async findByChannel(channelId: string): Promise<SessionRecord | null> {
    return this.store.findByChannel(channelId);
  }
  async bindChannel(sessionId: string, channelId: string): Promise<void> {
    const record = await this.store.get(sessionId);
    if (!record) return;

    if (record.kind === "worker") {
      this.logger.warn("Cannot bind channel to worker session", {
        sessionId,
        channelId,
      });
      return;
    }

    if (record.channelBindings.some((binding) => channelBindingId(binding) === channelId)) return;

    const updated: SessionRecord = {
      ...record,
      channelBindings: appendChannelBinding(record.channelBindings, this.bindingFor(channelId)),
    };

    await this.store.save(updated);
    this.emitPresenceForBinding(updated, this.bindingFor(channelId), "bound", "active", "active");

    this.logger.info("Channel bound to session", {
      sessionId,
      channelId,
    });
  }
  async unbindChannel(sessionId: string, channelId: string): Promise<void> {
    const record = await this.store.get(sessionId);
    if (!record) return;

    const removed = record.channelBindings.find(
      (binding) => channelBindingId(binding) === channelId,
    );
    const updated: SessionRecord = {
      ...record,
      channelBindings: removeChannelBinding(record.channelBindings, channelId),
    };

    await this.store.save(updated);
    if (removed !== undefined) {
      this.emitPresenceForBinding(record, removed, "unbound", "offline", "left");
    }

    this.logger.info("Channel unbound from session", {
      sessionId,
      channelId,
    });
  }

  async routeMessage(channel: ChannelProvider, message: ChannelMessage): Promise<void> {
    const record = await this.resolveSession(message.channelId);
    await this.turnCoordinator.run(record.id, () =>
      this.processQueuedTurn(channel, message, record.id),
    );
  }

  private async processQueuedTurn(
    channel: ChannelProvider,
    message: ChannelMessage,
    sessionId: string,
  ): Promise<void> {
    const record = await this.prepareSessionForTurn(sessionId, message.channelId);
    if (record === null) return;
    const instanceId = record.instanceId;
    if (!instanceId) {
      this.logger.warn("Session has no instance, cannot process message", { sessionId });
      return;
    }
    const instance = this.pool.get(instanceId);
    if (!instance) {
      this.logger.warn("Instance not found in pool", { instanceId, sessionId });
      return;
    }
    await this.processTurn(channel, message, record, instance);
  }

  private async prepareSessionForTurn(
    sessionId: string,
    channelId: string,
  ): Promise<SessionRecord | null> {
    const record = await this.store.get(sessionId);
    if (record === null) return null;
    if (record.kind !== "conversational") return record;
    const instanceId = record.instanceId;
    const hasLiveInstance = instanceId !== null && this.pool.has(instanceId);
    if (hasLiveInstance) return record;
    const reason = instanceId === null ? "idle_session" : "instance_missing";
    const instance = await this.pool.acquire(
      record.profileId,
      record.workerBinding?.role,
      record.effectiveRuntime ?? undefined,
      record.id,
    );
    const rehydrated: typeof record = {
      ...record,
      instanceId: instance.id,
      state: "active",
      lastActiveAt: new Date().toISOString(),
    };
    await this.store.save(rehydrated);
    this.emitPresence(rehydrated, "rehydrated", "active", "active");
    this.eventBus.emit({
      event: "session.rehydrated",
      payload: {
        sessionId: record.id,
        profileId: record.profileId,
        channelId,
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
    return rehydrated;
  }

  private async processTurn(
    channel: ChannelProvider,
    message: ChannelMessage,
    record: SessionRecord,
    instance: AgentInstance,
  ): Promise<void> {
    this.emitPresence(record, "routed", "busy", "active");
    try {
      const response = await withTurnTimeout(
        instance.processMessage(message),
        this.turnCoordinator.turnTimeoutMs,
      );
      await channel.sendMessage(message.channelId, response);
      this.emitPresence(record, "routed", "active", "active");
      this.logger.debug("Agent response sent", {
        sessionId: record.id,
        channelId: message.channelId,
      });
    } catch (error: unknown) {
      const timedOut = isConversationalTurnTimeoutError(error);
      this.emitPresence(record, "idle_evicted", "degraded", "active");
      this.logger.error("Agent processMessage failed", {
        sessionId: record.id,
        channelId: message.channelId,
        error: error instanceof Error ? error.message : String(error),
        timedOut,
      });
      if (timedOut) await this.markTimedOutTurnIdle(record, instance.id);
      await channel.sendMessage(message.channelId, {
        kind: "text",
        text: timedOut
          ? "The agent timed out while responding. Please try again."
          : "The agent hit an internal error while responding. Please try again.",
      });
      this.emitPresence(record, "routed", timedOut ? "idle" : "active", "active");
    }
  }

  private async markTimedOutTurnIdle(record: SessionRecord, instanceId: string): Promise<void> {
    await this.pool.release(instanceId);
    const current = await this.store.get(record.id);
    if (current?.instanceId !== instanceId) return;
    const updated: SessionRecord = {
      ...current,
      state: "idle",
      instanceId: null,
      lastActiveAt: new Date().toISOString(),
    };
    await this.store.save(updated);
    this.emitPresence(updated, "idle_evicted", "idle", "active");
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
  private async resolveSession(channelId: string): Promise<SessionRecord> {
    // 1. Look for an existing in-progress session bound to this channel.
    const existing = await this.findByChannel(channelId);

    if (existing && existing.state !== "archived") {
      // Touch the instance to prevent idle eviction.
      if (existing.instanceId) {
        this.pool.touch(existing.instanceId);
      }

      this.emitPresence(existing, "routed", "active", "active");

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
      profileId: this.fallbackProfileId,
      kind: "conversational",
      channelBindings: [this.bindingFor(channelId)],
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
    this.emitPresence(record, "archived", "offline", "left");

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
        this.emitPresence(updated, "idle_evicted", "idle", "active");
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

  private emitPresence(
    record: SessionRecord,
    reason: EventPayload<"session.presence">["reason"],
    subscriptionStatus: ChannelSubscriptionStatus,
    membershipStatus?: ChannelMembershipStatus,
  ): void {
    if (record.kind !== "conversational") return;
    for (const binding of record.channelBindings) {
      this.emitPresenceForBinding(record, binding, reason, subscriptionStatus, membershipStatus);
    }
  }

  private emitPresenceForBinding(
    record: SessionRecord,
    binding: ChannelBinding,
    reason: EventPayload<"session.presence">["reason"],
    subscriptionStatus: ChannelSubscriptionStatus,
    membershipStatus?: ChannelMembershipStatus,
  ): void {
    if (record.kind !== "conversational") return;
    const channelBinding: ChannelBindingRecord = isChannelBindingRecord(binding)
      ? binding
      : { providerId: "legacy", channelId: binding };
    this.eventBus.emit({
      event: "session.presence",
      payload: {
        sessionId: record.id,
        profileId: record.profileId,
        kind: "conversational",
        channelBinding,
        agentInstanceId: record.instanceId,
        subscriptionStatus,
        membershipStatus,
        reason,
      },
    });
  }

  private bindingFor(channelId: string): ChannelBinding {
    return this.fallbackBinding?.(channelId) ?? channelId;
  }
}
