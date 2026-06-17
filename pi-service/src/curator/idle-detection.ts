/** Idle detection — check whether curator should run. */

import type { IdleCheckResult } from "./types.js";

/**
 * Check if the system is idle enough for curator to run.
 */
export function checkIdle(
  activeAssignments: number,
  activeSessions: number,
  inDrain: boolean,
): IdleCheckResult {
  if (inDrain) {
    return { idle: false, reason: "System is in drain mode" };
  }
  if (activeAssignments > 0) {
    return { idle: false, reason: `Active assignments: ${activeAssignments}` };
  }
  if (activeSessions > 0) {
    return { idle: false, reason: `Active sessions: ${activeSessions}` };
  }
  return { idle: true };
}
