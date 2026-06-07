/**
 * Builds a WorkerPolicy from role config defaults and assignment binding data.
 *
 * @module pi-service/workers/worker-policy-builder
 */

import type { WorkerPolicy } from "@pi-crew/core";
import type { WorkerBinding } from "../sessions/types.js";
import type { WorkerRoleConfig } from "./worker-role-config.js";

/**
 * Construct a WorkerPolicy from assignment binding and optional role config.
 * Fields present in role config are used; absent fields get sensible defaults.
 */
export function buildWorkerPolicy(
  binding: WorkerBinding,
  roleConfig?: WorkerRoleConfig,
): WorkerPolicy {
  const defaults = roleConfig?.toolPolicyDefaults;
  return {
    assignmentId: binding.assignmentId,
    role: binding.role,
    workdir: defaults?.workdirRoot ?? "/tmp",
    allowedPaths: [],
    denyPaths: [],
    allowedTools: defaults?.allowedTools ?? [],
    deniedTools: defaults?.deniedTools ?? [],
    allowedHosts: defaults?.allowedHosts ?? [],
    deniedHosts: defaults?.deniedHosts ?? [],
    maxDurationMs: defaults?.assignmentTimeoutMs ?? 30 * 60 * 1000,
    maxTurnDurationMs: defaults?.idleTimeoutMs ?? 5 * 60 * 1000,
    idleTimeoutMs: defaults?.idleTimeoutMs ?? 5 * 60 * 1000,
    maxIterations: 100,
    maxTokensPerTurn: 200000,
    credentialScope: (defaults?.credentialScope ?? "bounded_write") as WorkerPolicy["credentialScope"],
    releaseOnCompletion: true,
    cleanupWorkdir: false,
  };
}
