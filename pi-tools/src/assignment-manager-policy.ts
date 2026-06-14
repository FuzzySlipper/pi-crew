/**
 * Assignment-manager policy — a full agent capability tier
 * that can drive worker assignments without unrestricted worker lifecycle access.
 *
 * DESIGN: Assignment-manager agents occupy a middle ground between ordinary
 * full-agent sessions and full worker sessions. They may:
 *
 *   - Read Den state (tasks, messages, documents, worker run status)
 *   - Create and monitor worker assignments (lease, cleanup, list pool)
 *   - Inspect worker completions and review state
 *
 * They must NOT:
 *
 *   - Post completions or worker packets (that's the worker's job)
 *   - Release assignments directly (workers own their own lifecycle)
 *   - Use context_status, request_checkpoint, or record_cleanup_evidence
 *   - Spawn subagents directly (subagent delegation goes through worker path)
 *
 * Rationale: An assignment-driving full agent orchestrates work
 * through the Den-managed worker path. It never impersonates a worker or
 * short-circuits the assignment lifecycle.
 *
 * @module pi-tools/assignment-manager-policy
 */

import type { CredentialAccessLevel, ExecutionPolicy } from "@pi-crew/core";
import { createExecutionPolicy } from "./execution-policy.js";
import { WORKER_ONLY_TOOLS } from "./full-agent-policy.js";

// ── Assignment-manager tool categories ─────────────────────────

/**
 * Tool names that are safe for any agent — Den read-only operations
 * and general-purpose tools that carry no lifecycle side effects.
 */
export const ASSIGNMENT_MANAGER_SAFE_TOOLS: ReadonlySet<string> = new Set([
  // Den read tools
  "get_task",
  "get_messages",
  "get_thread",
  "get_document",
  "search_documents",
  "query_librarian",
  "get_latest_task_packet",
  "get_task_workflow_summary",
  "list_review_rounds",
  "list_review_findings",
  // Assignment monitoring (read-only)
  "get_worker_run_status",
  "get_latest_worker_completion",
  "list_assignments",
  "list_pool_members",
  "get_assignment",
  // Assignment creation/cleanup (bounded writes)
  "lease_worker",
  "cleanup_worker_run",
  "determine_orchestrator_next_action",
  // Task writes (creating tasks for workers)
  "create_task",
  "update_task",
  "send_message",
  "send_user_notification",
  // General safe tools
  "web_search",
  "read_file",
]);

/**
 * Tool names that are denied for assignment-manager agents even though
 * they might be available in the MCP registry.
 *
 * Includes:
 * - All worker-only lifecycle tools (completions, checkpoints, cleanup evidence)
 * - Subagent spawning (must go through proper worker assignment path)
 * - Assignment release (workers own their lifecycle)
 */
export const ASSIGNMENT_MANAGER_DENIED_TOOLS: ReadonlySet<string> = new Set([
  // Worker-only lifecycle tools — always denied
  ...WORKER_ONLY_TOOLS,
  "post_worker_completion_packet",
  // Subagent tools — must go through Den worker assignment path
  "spawn_subagent",
]);

// ── Policy input ───────────────────────────────────────────────

/**
 * Partial policy input for constructing an assignment-manager session policy.
 *
 * All fields are optional; sensible defaults are applied by
 * {@link createAssignmentManagerPolicy}.
 */
export interface AssignmentManagerPolicyInput {
  /** Correlation ID for event emission and logging. */
  readonly policyId: string;

  // Filesystem
  readonly rootPath?: string;
  readonly allowedPaths?: string[];
  readonly denyPaths?: string[];

  // Tools — assignment-manager uses allowlist by default
  readonly allowedTools?: string[];
  readonly deniedTools?: string[];

  // Network
  readonly allowedHosts?: string[];
  readonly deniedHosts?: string[];

  // Time
  readonly maxDurationMs?: number;
  readonly maxTurnDurationMs?: number;
  readonly idleTimeoutMs?: number;

  // Budget
  readonly maxIterations?: number;
  readonly maxTokensPerTurn?: number;

  // Credentials
  readonly credentialScope?: CredentialAccessLevel;
}

// ── Defaults ───────────────────────────────────────────────────

const ASSIGNMENT_MANAGER_ROOT_PATH = "/tmp/pi-assignment-manager";
const ASSIGNMENT_MANAGER_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const ASSIGNMENT_MANAGER_TURN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const ASSIGNMENT_MANAGER_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ASSIGNMENT_MANAGER_MAX_ITERATIONS = 100;
const ASSIGNMENT_MANAGER_MAX_TOKENS_PER_TURN = 128_000;

// ── Factory ────────────────────────────────────────────────────

/**
 * Create an {@link ExecutionPolicy} for an assignment-manager full-agent session.
 *
 * The policy uses an allowlist approach: by default, only tools in
 * {@link ASSIGNMENT_MANAGER_SAFE_TOOLS} are permitted. This ensures that
 * even if the MCP registry exposes worker lifecycle tools, the assignment-manager
 * agent cannot call them.
 *
 * Worker-only tools and subagent spawning are always denied regardless of
 * the caller's allowlist configuration.
 */
export function createAssignmentManagerPolicy(
  input: AssignmentManagerPolicyInput,
): ExecutionPolicy {
  // Build denied tools: worker-only + subagent + caller extras
  const hardDenied = [...ASSIGNMENT_MANAGER_DENIED_TOOLS];
  const callerDenied = input.deniedTools ?? [];
  const mergedDenied = [...new Set([...hardDenied, ...callerDenied])];

  // Build allowed tools: safe defaults + caller extras, minus any denied
  const safeDefaults = [...ASSIGNMENT_MANAGER_SAFE_TOOLS];
  const callerAllowed = input.allowedTools ?? [];
  const mergedAllowed = [...new Set([...safeDefaults, ...callerAllowed])];
  // Remove anything that's in the denied set
  const deniedSet = new Set(mergedDenied);
  const finalAllowed = mergedAllowed.filter((t) => !deniedSet.has(t));

  return createExecutionPolicy({
    policyId: input.policyId,
    rootPath: input.rootPath ?? ASSIGNMENT_MANAGER_ROOT_PATH,
    allowedPaths: input.allowedPaths,
    denyPaths: input.denyPaths,
    allowedTools: finalAllowed,
    deniedTools: mergedDenied,
    allowedHosts: input.allowedHosts,
    deniedHosts: input.deniedHosts,
    maxDurationMs: input.maxDurationMs ?? ASSIGNMENT_MANAGER_TIMEOUT_MS,
    maxTurnDurationMs: input.maxTurnDurationMs ?? ASSIGNMENT_MANAGER_TURN_TIMEOUT_MS,
    idleTimeoutMs: input.idleTimeoutMs ?? ASSIGNMENT_MANAGER_IDLE_TIMEOUT_MS,
    maxIterations: input.maxIterations ?? ASSIGNMENT_MANAGER_MAX_ITERATIONS,
    maxTokensPerTurn: input.maxTokensPerTurn ?? ASSIGNMENT_MANAGER_MAX_TOKENS_PER_TURN,
    credentialScope: input.credentialScope ?? "none",
  });
}

/**
 * Check whether a tool name is available to assignment-manager sessions.
 *
 * Returns `true` if the tool is in the safe set and not in the denied set.
 */
export function isAssignmentManagerTool(toolName: string): boolean {
  return ASSIGNMENT_MANAGER_SAFE_TOOLS.has(toolName)
    && !ASSIGNMENT_MANAGER_DENIED_TOOLS.has(toolName);
}
