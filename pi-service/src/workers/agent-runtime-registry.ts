/**
 * AgentRuntimeRegistry — tracks active supervised Agents by run ID
 * so the steer/followUp bridge can route mid-assignment interaction
 * from Den Channels direct-agent events to the correct Agent.
 *
 * @module pi-service/workers/agent-runtime-registry
 */

import type { AgentSupervisor, SteerableAgent } from "./agent-supervisor.js";

/**
 * An entry in the runtime registry representing an active supervised Agent.
 */
export interface AgentRuntimeEntry {
  /** The supervised Agent (supports steer/followUp). */
  readonly agent: SteerableAgent;
  /** The AgentSupervisor wrapping this Agent for telemetry. */
  readonly supervisor: AgentSupervisor;
}

/**
 * Tracks active Agent runtimes by run ID and assignment ID,
 * providing O(1) lookups for the steer/followUp ingress bridge.
 *
 * Workers register on Agent start and unregister on Agent end.
 * The bridge queries by runId (primary) or assignmentId (secondary)
 * from direct-agent event metadata.
 */
export class AgentRuntimeRegistry {
  readonly #byRunId = new Map<string, AgentRuntimeEntry>();
  readonly #byAssignmentId = new Map<string, AgentRuntimeEntry>();

  /**
   * Register an active agent runtime.
   *
   * @param runId — Den worker run ID (primary lookup key).
   * @param assignmentId — Den assignment ID (secondary lookup key).
   * @param entry — The agent and supervisor to register.
   *
   * Idempotent — re-registering the same runId overwrites the previous entry.
   */
  register(runId: string, assignmentId: string, entry: AgentRuntimeEntry): void {
    // Clean up old assignment mapping if this runId was previously registered
    const old = this.#byRunId.get(runId);
    if (old !== undefined) {
      // Find and remove old assignment mapping
      for (const [aid, e] of this.#byAssignmentId) {
        if (e === old) {
          this.#byAssignmentId.delete(aid);
          break;
        }
      }
    }
    this.#byRunId.set(runId, entry);
    this.#byAssignmentId.set(assignmentId, entry);
  }

  /**
   * Remove an agent from the registry by run ID.
   *
   * Safe to call even if the runId is not registered.
   */
  unregister(runId: string): void {
    const entry = this.#byRunId.get(runId);
    if (entry !== undefined) {
      // Remove assignment mapping(s) pointing to this entry
      for (const [aid, e] of this.#byAssignmentId) {
        if (e === entry) {
          this.#byAssignmentId.delete(aid);
        }
      }
    }
    this.#byRunId.delete(runId);
  }

  /**
   * Find an active agent by its worker run ID (primary lookup).
   */
  findByRunId(runId: string): AgentRuntimeEntry | undefined {
    return this.#byRunId.get(runId);
  }

  /**
   * Find an active agent by its Den assignment ID (secondary lookup).
   */
  findByAssignmentId(assignmentId: string): AgentRuntimeEntry | undefined {
    return this.#byAssignmentId.get(assignmentId);
  }

  steerByRunId(runId: string, message: Parameters<SteerableAgent["steer"]>[0]): boolean {
    const entry = this.findByRunId(runId);
    if (entry === undefined) return false;
    entry.supervisor.clearCheckpoint();
    entry.agent.steer(message);
    return true;
  }

  followUpByRunId(runId: string, message: Parameters<SteerableAgent["followUp"]>[0]): boolean {
    const entry = this.findByRunId(runId);
    if (entry === undefined) return false;
    entry.supervisor.clearCheckpoint();
    entry.agent.followUp(message);
    return true;
  }

  /** Number of currently registered agents. */
  get size(): number {
    return this.#byRunId.size;
  }

  /** Whether the registry is empty. */
  get isEmpty(): boolean {
    return this.#byRunId.size === 0;
  }
}
