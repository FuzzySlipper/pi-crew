/**
 * Startup hydration — recover active sessions and reconcile with Den.
 *
 * On gateway start, this helper loads active sessions from the runtime
 * DB, verifies worker bindings against Den (via an injected reader),
 * archives orphaned/terminal worker sessions, and reports the recovery
 * state.
 *
 * @module pi-service/persistence/startup-hydration
 */

import type { SessionRecord } from "../sessions/types.js";
import type { SqliteSessionStore, DenAssignmentReader, DenAssignmentStatus } from "./types.js";
import type { Logger } from "@pi-crew/core";

// ── Hydration result ───────────────────────────────────────────────

/** Summary returned after startup hydration completes. */
export interface HydrationResult {
  /** Number of active sessions loaded from the DB. */
  activeSessions: number;
  /** Number of conversational sessions loaded. */
  conversationalSessions: number;
  /** Number of worker sessions loaded. */
  workerSessions: number;
  /** Session IDs that were archived (orphaned/terminal workers). */
  archivedSessionIds: string[];
  /** Any diagnostics or warnings produced during hydration. */
  diagnostics: string[];
}

// ── Hydrator ───────────────────────────────────────────────────────

/**
 * Hydrates the runtime from the local persistence store.
 *
 * Dependencies are constructor-injected so tests can provide stubs.
 */
export class StartupHydrator {
  readonly #store: SqliteSessionStore;
  readonly #denReader: DenAssignmentReader;
  readonly #logger: Logger;

  constructor(
    store: SqliteSessionStore,
    denReader: DenAssignmentReader,
    logger: Logger,
  ) {
    this.#store = store;
    this.#denReader = denReader;
    this.#logger = logger;
  }

  /**
   * Execute startup hydration.
   *
   * 1. Load all active sessions from the local DB.
   * 2. For worker sessions: verify bindings against Den.
   * 3. Archive orphaned or terminal worker sessions.
   * 4. Return a summary of the recovered state.
   */
  async hydrate(): Promise<HydrationResult> {
    const diagnostics: string[] = [];

    // Load all active sessions.
    const activeSessions = await this.#store.findByStatus("active");

    this.#logger.info(
      `Hydration: loaded ${String(activeSessions.length)} active sessions`,
    );

    // Separate worker and conversational sessions.
    const workerSessions = activeSessions.filter((s) => s.kind === "worker");
    const conversationalSessions = activeSessions.filter(
      (s) => s.kind === "conversational",
    );

    // Verify worker bindings against Den.
    const archivedIds = await this.#verifyWorkerBindings(
      workerSessions,
      diagnostics,
    );

    if (archivedIds.length > 0) {
      await this.#store.archiveMany(archivedIds);
      this.#logger.info(
        `Hydration: archived ${String(archivedIds.length)} orphaned/terminal worker sessions`,
        { archivedIds },
      );
    }

    return {
      activeSessions: activeSessions.length,
      conversationalSessions: conversationalSessions.length,
      workerSessions: workerSessions.length,
      archivedSessionIds: archivedIds,
      diagnostics,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Verify worker session bindings against Den.
   *
   * Returns the IDs of sessions that should be archived because their
   * worker assignment is no longer active.
   */
  async #verifyWorkerBindings(
    sessions: SessionRecord[],
    diagnostics: string[],
  ): Promise<string[]> {
    const toArchive: string[] = [];

    // Collect unique assignment IDs.
    const assignmentIds = new Set<string>();
    const sessionByAssignment = new Map<string, string[]>();

    for (const session of sessions) {
      const binding = session.workerBinding;
      if (!binding) continue;

      assignmentIds.add(binding.assignmentId);

      const existing = sessionByAssignment.get(binding.assignmentId);
      if (existing) {
        existing.push(session.id);
      } else {
        sessionByAssignment.set(binding.assignmentId, [session.id]);
      }
    }

    if (assignmentIds.size === 0) return toArchive;

    // Query Den for assignment status.
    let statuses: DenAssignmentStatus[];
    try {
      statuses = await this.#denReader.checkAssignments([...assignmentIds]);
    } catch (err) {
      const msg = `Failed to check Den assignment status: ${(err as Error).message}`;
      diagnostics.push(msg);
      this.#logger.warn(msg);
      // If Den is unreachable, do NOT archive sessions — they may still
      // be valid.  Return empty archive list.
      return [];
    }

    for (const status of statuses) {
      if (!status.isActive) {
        const sessionIds = sessionByAssignment.get(status.assignmentId) ?? [];
        toArchive.push(...sessionIds);
        diagnostics.push(
          `Worker session(s) for assignment ${status.assignmentId}: Den reports ${status.terminalState ?? "terminal"} — archiving`,
        );
      }
    }

    return toArchive;
  }
}
