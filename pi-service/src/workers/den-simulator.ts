/**
 * DenSimulator — faithful in-memory simulation of Den Core worker APIs.
 *
 * Simulates the assignment/claim/complete/release contract that Den Core
 * provides to worker runtimes. Used for capstone spike testing when Den
 * Core APIs are not yet implemented, providing exact documentation of
 * the expected external contract.
 *
 * Per the den-unavailability-policy ADR: if Den is down, workers stop.
 * This simulator exists solely to prove the runtime contract end-to-end
 * before live Den integration.
 *
 * @module pi-service/workers/den-simulator
 */

import type {
  CompletionPacket,
  CompletionPostResult,
} from "@pi-crew/core";

// ── Assignment state ──────────────────────────────────────────

/** Lifecycle states a Den assignment can occupy. */
export type DenAssignmentState =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "released";

/** A serializable Den assignment record (simulated). */
export interface DenAssignment {
  /** Den assignment ID. */
  readonly assignmentId: string;
  /** Den task ID. */
  readonly taskId: string;
  /** Den worker run ID. */
  readonly runId: string;
  /** Worker role. */
  readonly role: string;
  /** Current lifecycle state. */
  readonly state: DenAssignmentState;
  /** Identity of the worker that claimed this (null if unclaimed). */
  readonly claimedBy: string | null;
  /** When the assignment was created (ISO-8601). */
  readonly createdAt: string;
  /** When the assignment was claimed (ISO-8601, null if unclaimed). */
  readonly claimedAt: string | null;
  /** When the assignment was completed (ISO-8601, null if not completed). */
  readonly completedAt: string | null;
  /** When the assignment was released (ISO-8601, null if not released). */
  readonly releasedAt: string | null;
  /** The completion packet posted (null before completion). */
  readonly completionPacket: CompletionPacket | null;
  /** Audit trail of state transitions. */
  readonly transitions: string[];
}

/** Typed failure raised by the Den worker lifecycle simulator. */
export class DenSimulatorError extends Error {
  readonly code = "DEN_SIMULATOR_ERROR";

  constructor(
    message: string,
    readonly reason: "not_found" | "invalid_state",
  ) {
    super(message);
    this.name = "DenSimulatorError";
  }
}

// ── Simulator ─────────────────────────────────────────────────

/**
 * Faithful in-memory simulation of Den Core's worker assignment APIs.
 *
 * Tracks the full lifecycle of worker assignments with explicit state
 * transitions. Every mutation records an audit trail entry.
 */
export class DenSimulator {
  readonly #assignments = new Map<string, DenAssignment>();

  // ── Factory ────────────────────────────────────────────────

  /**
   * Create a new assignment in `pending` state.
   *
   * This simulates what Den Core does when an orchestrator assigns a
   * task to a worker role.
   */
  createAssignment(params: {
    assignmentId: string;
    taskId: string;
    runId: string;
    role: string;
  }): DenAssignment {
    const now = new Date().toISOString();
    const assignment: DenAssignment = {
      assignmentId: params.assignmentId,
      taskId: params.taskId,
      runId: params.runId,
      role: params.role,
      state: "pending",
      claimedBy: null,
      createdAt: now,
      claimedAt: null,
      completedAt: null,
      releasedAt: null,
      completionPacket: null,
      transitions: [`${now}: created (pending)`],
    };

    this.#assignments.set(params.assignmentId, assignment);
    return { ...assignment };
  }

  // ── Claim API ─────────────────────────────────────────────

  /**
   * Simulate a worker runtime claiming an assignment.
   *
   * Den Core would verify the lease, validate the worker identity,
   * and atomically transition state. The simulator mirrors this
   * contract.
   *
   * @throws If the assignment is not in a claimable state.
   */
  claimAssignment(
    assignmentId: string,
    workerIdentity: string,
  ): DenAssignment {
    const assignment = this.#requireAssignment(assignmentId);

    if (assignment.state !== "pending") {
      throw new DenSimulatorError(
        `Cannot claim assignment ${assignmentId}: current state is ${assignment.state}`,
        "invalid_state",
      );
    }

    const now = new Date().toISOString();
    const updated: DenAssignment = {
      ...assignment,
      state: "claimed",
      claimedBy: workerIdentity,
      claimedAt: now,
      transitions: [
        ...assignment.transitions,
        `${now}: claimed by ${workerIdentity}`,
      ],
    };

    this.#assignments.set(assignmentId, updated);
    return { ...updated };
  }

  // ── Complete API ──────────────────────────────────────────

  /**
   * Simulate accepting a structured CompletionPacket.
   *
   * Den Core would validate the packet (required fields present,
   * assignment exists, status is valid), reconcile against
   * assignment state, and record the completion.
   *
   * @returns {@link CompletionPostResult} with acceptance status.
   */
  postCompletion(
    assignmentId: string,
    packet: CompletionPacket,
  ): CompletionPostResult {
    const assignment = this.#requireAssignment(assignmentId);

    // Validate assignment is in a completable state
    if (assignment.state !== "claimed" && assignment.state !== "running") {
      return {
        accepted: false,
        message: `Cannot complete assignment ${assignmentId}: current state is ${assignment.state}`,
      };
    }

    // Validate required fields are present
    const missing = this.#validateRequiredFields(packet);
    if (missing.length > 0) {
      return {
        accepted: false,
        message: `Completion packet missing required fields: ${missing.join(", ")}`,
      };
    }

    // Validate packet matches assignment
    if (packet.assignmentId !== assignmentId) {
      return {
        accepted: false,
        message: `Packet assignmentId "${packet.assignmentId}" does not match assignment "${assignmentId}"`,
      };
    }

    const now = new Date().toISOString();
    const nextState: DenAssignmentState =
      packet.status === "completed" ? "completed" : "failed";

    const updated: DenAssignment = {
      ...assignment,
      state: nextState,
      completedAt: now,
      completionPacket: packet,
      transitions: [
        ...assignment.transitions,
        `${now}: completion posted (${packet.status})`,
      ],
    };

    this.#assignments.set(assignmentId, updated);
    return { accepted: true, message: "Completion packet accepted" };
  }

  // ── Release API ───────────────────────────────────────────

  /**
   * Simulate releasing an assignment back to the pool.
   *
   * Den Core would verify that completion was posted, transition
   * the assignment to released, and free the worker slot.
   */
  releaseAssignment(
    assignmentId: string,
    reason: string,
  ): DenAssignment {
    const assignment = this.#requireAssignment(assignmentId);

    if (assignment.state !== "completed" && assignment.state !== "failed") {
      throw new DenSimulatorError(
        `Cannot release assignment ${assignmentId}: current state is ${assignment.state}`,
        "invalid_state",
      );
    }

    const now = new Date().toISOString();
    const updated: DenAssignment = {
      ...assignment,
      state: "released",
      releasedAt: now,
      transitions: [
        ...assignment.transitions,
        `${now}: released (${reason})`,
      ],
    };

    this.#assignments.set(assignmentId, updated);
    return { ...updated };
  }

  // ── Query ─────────────────────────────────────────────────

  /** Get an assignment by ID, or null if not tracked. */
  getAssignment(assignmentId: string): DenAssignment | null {
    const assignment = this.#assignments.get(assignmentId);
    return assignment ? { ...assignment } : null;
  }

  /** List all tracked assignments. */
  listAssignments(): DenAssignment[] {
    return [...this.#assignments.values()].map((a) => ({ ...a }));
  }

  /** Count assignments by state. */
  countByState(state: DenAssignmentState): number {
    let count = 0;
    for (const assignment of this.#assignments.values()) {
      if (assignment.state === state) count += 1;
    }
    return count;
  }

  /** Clear all tracked assignments (for test isolation). */
  reset(): void {
    this.#assignments.clear();
  }

  // ── Validation ────────────────────────────────────────────

  /**
   * Validate required fields on a completion packet.
   *
   * Mirrors Den Core's validation contract. The packet-auditor
   * worker uses this same logic to produce findings.
   */
  readonly requiredFields = [
    "assignmentId",
    "runId",
    "taskId",
    "status",
    "artifacts",
    "tokensConsumed",
  ] as const;

  validatePacketRequiredFields(
    packet: Record<string, unknown>,
  ): string[] {
    const missing: string[] = [];
    for (const field of this.requiredFields) {
      if (packet[field] === undefined || packet[field] === null) {
        missing.push(field);
      } else if (field === "artifacts" && !Array.isArray(packet[field])) {
        missing.push("artifacts (must be an array)");
      } else if (
        field === "tokensConsumed" &&
        typeof packet[field] !== "number"
      ) {
        missing.push("tokensConsumed (must be a number)");
      }
    }
    return missing;
  }

  // ── Internal ──────────────────────────────────────────────

  #requireAssignment(assignmentId: string): DenAssignment {
    const assignment = this.#assignments.get(assignmentId);
    if (!assignment) {
      throw new DenSimulatorError(
        `Assignment ${assignmentId} not found`,
        "not_found",
      );
    }
    return assignment;
  }

  #validateRequiredFields(packet: CompletionPacket): string[] {
    const result: string[] = [];

    if (!packet.assignmentId || typeof packet.assignmentId !== "string") {
      result.push("assignmentId");
    }
    if (!packet.runId || typeof packet.runId !== "string") {
      result.push("runId");
    }
    if (!packet.taskId || typeof packet.taskId !== "string") {
      result.push("taskId");
    }
    const statusStr = packet.status as string;
    if (
      !statusStr ||
      !["completed", "failed", "blocked", "exhausted"].includes(
        statusStr,
      )
    ) {
      result.push("status");
    }
    if (!Array.isArray(packet.artifacts) || packet.artifacts.length === 0) {
      result.push("artifacts");
    }
    if (typeof packet.tokensConsumed !== "number") {
      result.push("tokensConsumed");
    }

    return result;
  }
}

// ── Known Den-side prerequisites ────────────────────────────────

/**
 * Documented gap between this simulation and live Den Core.
 *
 * When Den Core implements native assignment/claim/complete/release
 * APIs, the simulator is replaced by HTTP calls to Den Core. These
 * are the expected API contracts:
 *
 * ```
 * POST /api/v1/assignments/{id}/claim
 *   → 200 { assignmentId, state: "claimed", ... }
 *   → 409 Assignment not claimable
 *
 * POST /api/v1/assignments/{id}/complete
 *   → 200 { accepted: true, message: "..." }
 *   → 422 Missing required fields: [...]
 *
 * POST /api/v1/assignments/{id}/release
 *   → 200 { assignmentId, state: "released", ... }
 *   → 409 Cannot release
 *
 * GET /api/v1/assignments/{id}
 *   → 200 DenAssignment
 * ```
 */
export const DEN_WORKER_API_PREREQUISITES = {
  description:
    "Den Core must implement worker assignment claim/complete/release HTTP APIs.",
  endpoints: {
    claim: "POST /api/v1/assignments/{id}/claim",
    complete: "POST /api/v1/assignments/{id}/complete",
    release: "POST /api/v1/assignments/{id}/release",
    get: "GET /api/v1/assignments/{id}",
  },
  gap: "This simulator proves the runtime contract. Replace with HTTP calls when Den Core APIs exist.",
} as const;
