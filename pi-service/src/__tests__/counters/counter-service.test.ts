import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { DefaultCounterService, SqliteCounterRepository, type CounterService, type CounterThresholds } from "@pi-crew/service";

/**
 * Tests for CounterService — the background review turn/iteration tracking layer.
 *
 * Covers the full CounterService interface: increment, checkTrigger, reset, cleanup.
 * Does NOT require a running Crew instance or EventBus.
 */
describe("CounterService lifecycle", () => {
  let db: Database.Database;
  let service: CounterService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_counters (
        profile_id          TEXT NOT NULL,
        session_id          TEXT NOT NULL,
        turns_since_memory  INTEGER NOT NULL DEFAULT 0,
        iters_since_skill   INTEGER NOT NULL DEFAULT 0,
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (profile_id, session_id)
      )
    `);
    service = new DefaultCounterService(new SqliteCounterRepository(db));
  });

  const thresholds: CounterThresholds = {
    memoryNudgeInterval: 3,
    skillNudgeInterval: 5,
  };

  // ── Turn increment ──────────────────────────────────────────────

  it("increments turn counter from 0", async () => {
    await service.incrementTurn("profile-a", "session-1");
    const trigger = await service.checkTrigger("profile-a", "session-1", { memoryNudgeInterval: 1, skillNudgeInterval: 10 });
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe("memory");
    expect(trigger!.turnsSinceMemory).toBe(1);
  });

  it("accumulates multiple turns", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");

    const trigger = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe("memory");
    expect(trigger!.turnsSinceMemory).toBe(3);
  });

  it("separates counters by profile and session", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-b", "session-1");

    const triggerA = await service.checkTrigger("profile-a", "session-1", { memoryNudgeInterval: 1, skillNudgeInterval: 10 });
    expect(triggerA).not.toBeNull();

    // profile-b only has 1 turn -> threshold 3 not reached
    const triggerB = await service.checkTrigger("profile-b", "session-1", thresholds);
    expect(triggerB).toBeNull();
  });

  // ── Iteration increment ─────────────────────────────────────────

  it("increments iteration counter", async () => {
    await service.incrementIteration("profile-a", "session-1");

    const trigger = await service.checkTrigger("profile-a", "session-1", { memoryNudgeInterval: 10, skillNudgeInterval: 1 });
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe("skill");
    expect(trigger!.itersSinceSkill).toBe(1);
  });

  it("accumulates multiple iterations", async () => {
    for (let i = 0; i < 5; i++) {
      await service.incrementIteration("profile-a", "session-1");
    }

    const trigger = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe("skill");
    expect(trigger!.itersSinceSkill).toBe(5);
  });

  it("detects combined trigger when both thresholds reached", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1"); // memory threshold = 3

    // increment 5 iterations
    for (let i = 0; i < 5; i++) {
      await service.incrementIteration("profile-a", "session-1");
    }

    const trigger = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe("combined");
    expect(trigger!.turnsSinceMemory).toBe(3);
    expect(trigger!.itersSinceSkill).toBe(5);
  });

  // ── checkTrigger returns null when below thresholds ─────────────

  it("returns null when no threshold reached", async () => {
    await service.incrementTurn("profile-a", "session-1");
    const trigger = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger).toBeNull();
  });

  it("returns null for uninitialized session", async () => {
    const trigger = await service.checkTrigger("nonexistent", "session-1", thresholds);
    expect(trigger).toBeNull();
  });

  // ── Counter reset ───────────────────────────────────────────────

  it("resets memory counter at review START (not completion)", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");

    await service.resetCounter("profile-a", "session-1", "memory");

    const trigger = await service.checkTrigger("profile-a", "session-1", thresholds);
    // turns_since_memory reset to 0, iters_since_skill still 0
    expect(trigger).toBeNull();
  });

  it("resets skill counter", async () => {
    for (let i = 0; i < 5; i++) {
      await service.incrementIteration("profile-a", "session-1");
    }

    await service.resetCounter("profile-a", "session-1", "skill");

    const trigger = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger).toBeNull();
  });

  it("resets both counters on combined reset", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");
    for (let i = 0; i < 5; i++) {
      await service.incrementIteration("profile-a", "session-1");
    }

    await service.resetCounter("profile-a", "session-1", "combined");

    const trigger = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger).toBeNull();
  });

  it("counters continue incrementing after reset", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");
    await service.resetCounter("profile-a", "session-1", "memory");

    await service.incrementTurn("profile-a", "session-1");
    const trigger = await service.checkTrigger("profile-a", "session-1", { memoryNudgeInterval: 1, skillNudgeInterval: 10 });
    expect(trigger).not.toBeNull();
    expect(trigger!.turnsSinceMemory).toBe(1);
  });

  // ── Cleanup ─────────────────────────────────────────────────────

  it("cleanupSession removes counter row", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.cleanupSession("profile-a", "session-1");

    const trigger = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger).toBeNull(); // row deleted -> undefined -> null
  });

  it("cleanupSession is idempotent on nonexistent rows", async () => {
    await service.cleanupSession("nonexistent", "session-1");
    // Should not throw
  });

  // ── Different thresholds per check ───────────────────────────────

  it("uses per-call thresholds from profile config", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");

    // Use a tighter threshold to trigger
    const tightThreshold: CounterThresholds = { memoryNudgeInterval: 2, skillNudgeInterval: 10 };
    const trigger = await service.checkTrigger("profile-a", "session-1", tightThreshold);
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe("memory");

    // Use a looser threshold to not trigger
    const looseThreshold: CounterThresholds = { memoryNudgeInterval: 5, skillNudgeInterval: 10 };
    const noTrigger = await service.checkTrigger("profile-a", "session-1", looseThreshold);
    expect(noTrigger).toBeNull();
  });

  // ── Interleaved turn and tool counters ───────────────────────────

  it("tracks turns and iterations independently", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementIteration("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementIteration("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1"); // memory threshold

    const trigger = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe("memory"); // only memory reached
    expect(trigger!.turnsSinceMemory).toBe(3);
    expect(trigger!.itersSinceSkill).toBe(2);
  });

  // ── Counter NOT reset on trigger check (hook doesn't own reset) ─

  it("checkTrigger does NOT reset counters", async () => {
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");
    await service.incrementTurn("profile-a", "session-1");

    // First check — returns trigger
    const trigger1 = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger1).not.toBeNull();

    // Second check — still returns trigger (counters not reset)
    const trigger2 = await service.checkTrigger("profile-a", "session-1", thresholds);
    expect(trigger2).not.toBeNull();
    expect(trigger2!.turnsSinceMemory).toBe(3);
  });
});
