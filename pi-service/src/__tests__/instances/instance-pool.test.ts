/**
 * Tests for InstancePool.
 *
 * @module pi-service/__tests__/instances/instance-pool.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { InstancePoolImpl, DEFAULT_POOL_CONFIG } from "../../instances/instance-pool.js";
import type { InstancePoolConfig } from "../../instances/instance-pool.js";
import { InstanceFactoryImpl } from "../../instances/instance-factory.js";

function makeConfig(overrides: Partial<InstancePoolConfig> = {}): InstancePoolConfig {
  return { ...DEFAULT_POOL_CONFIG, ...overrides };
}

describe("InstancePoolImpl", () => {
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
  });

  describe("acquire", () => {
    it("creates and tracks a new instance", async () => {
      const factory = new InstanceFactoryImpl(logger);
      const pool = new InstancePoolImpl(factory, makeConfig(), logger);

      const instance = await pool.acquire("default");
      expect(instance.profileId).toBe("default");
      expect(instance.isDisposed).toBe(false);
      expect(pool.size).toBe(1);
      expect(pool.has(instance.id)).toBe(true);
    });

    it("creates multiple instances for the same profile", async () => {
      const factory = new InstanceFactoryImpl(logger);
      const pool = new InstancePoolImpl(factory, makeConfig(), logger);

      const a = await pool.acquire("default");
      const b = await pool.acquire("default");

      expect(pool.size).toBe(2);
      expect(a.id).not.toBe(b.id);
    });

    it("enforces per-profile max", async () => {
      const factory = new InstanceFactoryImpl(logger);
      const pool = new InstancePoolImpl(
        factory,
        makeConfig({ maxPerProfile: 1 }),
        logger,
      );

      await pool.acquire("default");
      await expect(pool.acquire("default")).rejects.toThrow(
        /capacity for profile/,
      );
    });

    it("enforces total max", async () => {
      const factory = new InstanceFactoryImpl(logger);
      const pool = new InstancePoolImpl(
        factory,
        makeConfig({ maxTotal: 2, maxPerProfile: 2 }),
        logger,
      );

      await pool.acquire("profile-a");
      await pool.acquire("profile-b");
      await expect(pool.acquire("profile-a")).rejects.toThrow(
        /total capacity/,
      );
    });
  });

  describe("release", () => {
    it("disposes and removes the instance", async () => {
      const factory = new InstanceFactoryImpl(logger);
      const pool = new InstancePoolImpl(factory, makeConfig(), logger);

      const instance = await pool.acquire("default");
      await pool.release(instance.id);

      expect(instance.isDisposed).toBe(true);
      expect(pool.size).toBe(0);
      expect(pool.has(instance.id)).toBe(false);
    });

    it("is a no-op for unknown instance id", async () => {
      const factory = new InstanceFactoryImpl(logger);
      const pool = new InstancePoolImpl(factory, makeConfig(), logger);

      await pool.release("nonexistent");
      expect(pool.size).toBe(0);
    });
  });

  describe("touch", () => {
    it("updates last-used timestamp preventing eviction", async () => {
      const factory = new InstanceFactoryImpl(logger);
      // Use a very short timeout so eviction is easy to test.
      const pool = new InstancePoolImpl(
        factory,
        makeConfig({ idleTimeoutMs: 10 }),
        logger,
      );

      const instance = await pool.acquire("default");

      // Wait briefly and touch.
      await new Promise((r) => setTimeout(r, 15));
      pool.touch(instance.id);

      // Evict — the touched instance should survive.
      const evicted = await pool.evictIdle();
      expect(evicted).toBe(0);
      expect(pool.has(instance.id)).toBe(true);
    });
  });

  describe("evictIdle", () => {
    it("evicts instances past idle timeout", async () => {
      const factory = new InstanceFactoryImpl(logger);
      const pool = new InstancePoolImpl(
        factory,
        makeConfig({ idleTimeoutMs: 10 }),
        logger,
      );

      const instance = await pool.acquire("default");

      // Wait past the timeout.
      await new Promise((r) => setTimeout(r, 20));

      const evicted = await pool.evictIdle();
      expect(evicted).toBe(1);
      expect(instance.isDisposed).toBe(true);
      expect(pool.size).toBe(0);
    });

    it("does not evict recently-used instances", async () => {
      const factory = new InstanceFactoryImpl(logger);
      const pool = new InstancePoolImpl(
        factory,
        makeConfig({ idleTimeoutMs: 5000 }),
        logger,
      );

      await pool.acquire("default");
      const evicted = await pool.evictIdle();
      expect(evicted).toBe(0);
      expect(pool.size).toBe(1);
    });

    it("returns zero when pool is empty", async () => {
      const factory = new InstanceFactoryImpl(logger);
      const pool = new InstancePoolImpl(factory, makeConfig(), logger);

      const evicted = await pool.evictIdle();
      expect(evicted).toBe(0);
    });
  });
});
