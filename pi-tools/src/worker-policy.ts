/**
 * Backward-compatible WorkerPolicy export surface.
 *
 * New generic policy helpers live in `execution-policy.ts`; this module stays
 * as a temporary direct-import compatibility shim for existing worker code.
 *
 * @module pi-tools/worker-policy
 */

export {
  type ExecutionPolicyInput,
  type WorkerPolicyInput,
  createExecutionPolicy,
  createWorkerPolicy,
  isPathAllowed,
  isHostAllowed,
  isCredentialAccessAllowed,
  resolvePolicyPath,
  isWithinOrEqual,
  trimTrailingSeparator,
  isIterationBudgetExhausted,
  isIterationBudgetLow,
} from "./execution-policy.js";
export type { CredentialAccessLevel } from "@pi-crew/core";
