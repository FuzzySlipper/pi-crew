/**
 * InstancePool — manages active {@link AgentInstance} objects.
 *
 * Each instance belongs to exactly one session. The pool tracks which
 * instances are live, enforces concurrency limits, and evicts idle
 * instances past a configurable timeout.
 *
 * @module pi-service/instances/instance-pool
 */

import { SessionLimitError, type Logger } from "@pi-crew/core";
import type { AgentInstance } from "./agent-instance.js";
import type { InstanceFactory } from "./instance-factory.js";

// ── Pool config ─────────────────────────────────────────────────

/** Configuration for {@link InstancePool}. */
export interface InstancePoolConfig {
  /** Maximum instances allowed per profile. */
  readonly maxPerProfile: number;
  /** Maximum total instances across all profiles. */
  readonly maxTotal: number;
  /** Idle timeout in milliseconds before an instance is eligible for eviction. */
  readonly idleTimeoutMs: number;
}

/** Default pool configuration. */
export const DEFAULT_POOL_CONFIG: InstancePoolConfig = {
  maxPerProfile: 4,
  maxTotal: 16,
  idleTimeoutMs: 8 * 60 * 60 * 1000, // 8 hours
};

// ── InstancePool interface ──────────────────────────────────────

/**
 * Manages live {@link AgentInstance} objects keyed by instance ID.
 *
 * Instances are 1:1 with sessions. The pool tracks which instances are
 * live, enforces limits, and evicts idle instances.
 */
export interface InstancePool {
  /**
   * Acquire an instance for a profile.
   *
   * Creates a new instance via the factory each time — instances are
   * never reused across sessions.
   *
   * @param profileId — Profile to create an instance for.
   * @param role — Optional worker role hint.
   * @returns A fresh, undisposed instance.
   * @throws Error if pool is at capacity.
   */
  acquire(profileId: string, role?: string): Promise<AgentInstance>;

  /**
   * Release (dispose) an instance and remove it from the pool.
   *
   * @param instanceId — Instance to release.
   */
  release(instanceId: string): Promise<void>;

  /**
   * Evict instances that have been idle longer than the configured timeout.
   *
   * @returns Number of instances evicted.
   */
  evictIdle(): Promise<number>;

  /** Number of instances currently tracked. */
  readonly size: number;

  /**
   * Update the last-used timestamp for an instance (touch on activity).
   *
   * Prevents the instance from being evicted by the periodic idle sweep.
   */
  touch(instanceId: string): void;

  /** Check whether an instance is currently tracked. */
  has(instanceId: string): boolean;
}

// ── InstancePool implementation ─────────────────────────────────

/** Internal entry for a tracked instance. */
interface PoolEntry {
  instance: AgentInstance;
  profileId: string;
  lastUsedAt: Date;
}

/**
 * Default {@link InstancePool} implementation.
 *
 * Tracks live instances, enforces concurrency limits, and provides
 * LRU idle-eviction via {@link evictIdle}.
 */
export class InstancePoolImpl implements InstancePool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(
    private readonly factory: InstanceFactory,
    private readonly config: InstancePoolConfig,
    private readonly logger: Logger,
  ) {}

  // ── InstancePool contract ─────────────────────────────────────

  async acquire(profileId: string, role?: string): Promise<AgentInstance> {
    // Enforce max total
    if (this.entries.size >= this.config.maxTotal) {
      throw new SessionLimitError(
        `Instance pool at total capacity (${String(this.config.maxTotal)})`,
      );
    }

    // Enforce max per profile
    const profileCount = [...this.entries.values()].filter(
      (e) => e.profileId === profileId,
    ).length;
    if (profileCount >= this.config.maxPerProfile) {
      throw new SessionLimitError(
        `Instance pool at capacity for profile "${profileId}" (${String(this.config.maxPerProfile)})`,
      );
    }

    const instance = await this.factory.create(profileId, role);

    this.entries.set(instance.id, {
      instance,
      profileId,
      lastUsedAt: new Date(),
    });

    this.logger.debug("Instance acquired", {
      instanceId: instance.id,
      profileId,
      poolSize: this.entries.size,
    });

    return instance;
  }

  async release(instanceId: string): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry) return;

    await entry.instance.dispose();
    this.entries.delete(instanceId);

    this.logger.debug("Instance released", {
      instanceId,
      poolSize: this.entries.size,
    });
  }

  async evictIdle(): Promise<number> {
    const now = Date.now();
    const timeoutMs = this.config.idleTimeoutMs;
    let evicted = 0;

    for (const [id, entry] of this.entries) {
      const idleMs = now - entry.lastUsedAt.getTime();
      if (idleMs >= timeoutMs) {
        await entry.instance.dispose();
        this.entries.delete(id);
        evicted += 1;
      }
    }

    if (evicted > 0) {
      this.logger.info("Idle instances evicted", {
        evicted,
        remaining: this.entries.size,
      });
    }

    return evicted;
  }

  get size(): number {
    return this.entries.size;
  }

  // ── Internal helpers ──────────────────────────────────────────

  /** Update the last-used timestamp for an instance (touch on turn start). */
  touch(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (entry) {
      entry.lastUsedAt = new Date();
    }
  }

  /** Check whether an instance is tracked. */
  has(instanceId: string): boolean {
    return this.entries.has(instanceId);
  }
}
