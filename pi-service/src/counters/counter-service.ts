/**
 * CounterService — lightweight review-cycle counter tracking.
 *
 * Tracks turns and tool iterations per profile+session pair in a
 * dedicated SQLite table. Used by the background review lifecycle
 * to determine when to trigger memory/skill review passes.
 *
 * @module pi-service/counters/counter-service
 */

import type { Database } from "better-sqlite3";
import type { CounterRow, CounterThresholds, CounterTriggerResult, TriggerType } from "../persistence/types.js";

/**
 * CounterService for the background review system.
 */
export interface CounterService {
  /** Called after every completed user turn. */
  incrementTurn(profileId: string, sessionId: string): Promise<void>;

  /** Called on every tool dispatch during a turn. */
  incrementIteration(profileId: string, sessionId: string): Promise<void>;

  /** Check whether any trigger threshold has been reached. */
  checkTrigger(profileId: string, sessionId: string, thresholds: CounterThresholds): Promise<CounterTriggerResult | null>;

  /** Reset counters. Called by caretaker at review START. */
  resetCounter(profileId: string, sessionId: string, triggerType: TriggerType): Promise<void>;

  /** Called on session end to clean up counters. */
  cleanupSession(profileId: string, sessionId: string): Promise<void>;
}

/**
 * SQLite-backed CounterRepository.
 */
export class SqliteCounterRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Upsert — increments turn counter (or inserts with defaults).
   */
  incrementTurn(profileId: string, sessionId: string): void {
    this.#db.prepare(`
      INSERT INTO review_counters (profile_id, session_id, turns_since_memory, iters_since_skill, updated_at)
      VALUES (?, ?, 1, 0, datetime('now'))
      ON CONFLICT(profile_id, session_id) DO UPDATE SET
        turns_since_memory = turns_since_memory + 1,
        updated_at = datetime('now')
    `).run(profileId, sessionId);
  }

  /**
   * Upsert — increments iteration counter (or inserts with defaults).
   */
  incrementIteration(profileId: string, sessionId: string): void {
    this.#db.prepare(`
      INSERT INTO review_counters (profile_id, session_id, turns_since_memory, iters_since_skill, updated_at)
      VALUES (?, ?, 0, 1, datetime('now'))
      ON CONFLICT(profile_id, session_id) DO UPDATE SET
        iters_since_skill = iters_since_skill + 1,
        updated_at = datetime('now')
    `).run(profileId, sessionId);
  }

  /**
   * Get current counter values for a profile+session pair.
   */
  getCounter(profileId: string, sessionId: string): CounterRow | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM review_counters WHERE profile_id = ? AND session_id = ?",
    ).get(profileId, sessionId) as CounterRow | undefined;
    return row;
  }

  /**
   * Reset turn counter to 0.
   */
  resetTurnCounter(profileId: string, sessionId: string): void {
    this.#db.prepare(`
      INSERT INTO review_counters (profile_id, session_id, turns_since_memory, iters_since_skill, updated_at)
      VALUES (?, ?, 0, 0, datetime('now'))
      ON CONFLICT(profile_id, session_id) DO UPDATE SET
        turns_since_memory = 0,
        updated_at = datetime('now')
    `).run(profileId, sessionId);
  }

  /**
   * Reset iteration counter to 0.
   */
  resetIterationCounter(profileId: string, sessionId: string): void {
    this.#db.prepare(`
      INSERT INTO review_counters (profile_id, session_id, turns_since_memory, iters_since_skill, updated_at)
      VALUES (?, ?, 0, 0, datetime('now'))
      ON CONFLICT(profile_id, session_id) DO UPDATE SET
        iters_since_skill = 0,
        updated_at = datetime('now')
    `).run(profileId, sessionId);
  }

  /**
   * Delete counter row for a profile+session pair.
   */
  deleteSession(profileId: string, sessionId: string): void {
    this.#db.prepare(
      "DELETE FROM review_counters WHERE profile_id = ? AND session_id = ?",
    ).run(profileId, sessionId);
  }
}

/**
 * Default CounterService implementation backed by SqliteCounterRepository.
 */
export class DefaultCounterService implements CounterService {
  readonly #repository: SqliteCounterRepository;

  constructor(repository: SqliteCounterRepository) {
    this.#repository = repository;
  }

  async incrementTurn(profileId: string, sessionId: string): Promise<void> {
    this.#repository.incrementTurn(profileId, sessionId);
  }

  async incrementIteration(profileId: string, sessionId: string): Promise<void> {
    this.#repository.incrementIteration(profileId, sessionId);
  }

  async checkTrigger(
    profileId: string,
    sessionId: string,
    thresholds: CounterThresholds,
  ): Promise<CounterTriggerResult | null> {
    const row = this.#repository.getCounter(profileId, sessionId);
    if (row === undefined) return null;

    const memoryTriggered = row.turns_since_memory >= thresholds.memoryNudgeInterval;
    const skillTriggered = row.iters_since_skill >= thresholds.skillNudgeInterval;

    if (!memoryTriggered && !skillTriggered) return null;

    const type: TriggerType = memoryTriggered && skillTriggered ? "combined" : memoryTriggered ? "memory" : "skill";

    return {
      type,
      turnsSinceMemory: row.turns_since_memory,
      itersSinceSkill: row.iters_since_skill,
    };
  }

  async resetCounter(profileId: string, sessionId: string, triggerType: TriggerType): Promise<void> {
    if (triggerType === "memory" || triggerType === "combined") {
      this.#repository.resetTurnCounter(profileId, sessionId);
    }
    if (triggerType === "skill" || triggerType === "combined") {
      this.#repository.resetIterationCounter(profileId, sessionId);
    }
  }

  async cleanupSession(profileId: string, sessionId: string): Promise<void> {
    this.#repository.deleteSession(profileId, sessionId);
  }
}
