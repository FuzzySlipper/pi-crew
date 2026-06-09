/** Delegated child runner for service-owned session materialization. */

import type { DelegatedResult } from "@pi-crew/core";
import type {
  DelegatedChildRunInput,
  DelegatedChildRunner,
} from "./delegated-spawn-lifecycle.js";

/**
 * Marks a delegated child session as visible once the service has created it.
 *
 * DESIGN: concrete child execution substrates are wired through the service
 * bridge, while this runner records the service-owned lifecycle boundary.
 * Rationale: spawn_subagent should create a durable child session and visibility
 * events without silently falling back to hidden Hermes orchestration.
 */
export class SessionMaterializedDelegatedChildRunner implements DelegatedChildRunner {
  async run(input: DelegatedChildRunInput): Promise<DelegatedResult> {
    const startedAt = Date.now();
    await input.emitTurnVisible({
      turnNumber: 1,
      phase: "started",
      durationMs: undefined,
      error: undefined,
    });
    await input.emitTurnVisible({
      turnNumber: 1,
      phase: "completed",
      durationMs: Date.now() - startedAt,
      error: undefined,
    });
    return {
      outcome: "success",
      summary: `Delegated child session materialized: ${input.childSession.sessionId}`,
      policyId: input.policy.policyId,
      childSessionId: input.childSession.sessionId,
      effectiveRuntime: input.effectiveRuntime,
      turnsUsed: 1,
      tokensConsumed: 0,
      durationMs: Date.now() - startedAt,
    };
  }
}
