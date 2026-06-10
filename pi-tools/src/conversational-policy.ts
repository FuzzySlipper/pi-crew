/**
 * Conversational session execution policy derivation.
 *
 * Derives an {@link ExecutionPolicy} from profile/config input for ordinary
 * conversational sessions. Worker policy derivation is unchanged; see
 * {@link createWorkerPolicy} in execution-policy.ts.
 *
 * DESIGN: Conversational sessions get a more permissive path/workspace policy
 * than workers (no isolated workdir), but tools are restricted: worker-only
 * tools such as structured completion and assignment release are always denied.
 * Rationale: ordinary conversations must never impersonate worker lifecycle.
 *
 * @module pi-tools/conversational-policy
 */

import type { CredentialAccessLevel, ExecutionPolicy } from "@pi-crew/core";
import { createExecutionPolicy } from "./execution-policy.js";

// ── Worker-only tools ─────────────────────────────────────────

/**
 * Tool names that are exclusive to worker sessions and must never
 * appear in a conversational session's tool surface.
 */
export const WORKER_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "post_structured_completion",
  "context_status",
  "request_checkpoint",
  "release_assignment",
  "record_cleanup_evidence",
]);

// ── Conversational defaults ────────────────────────────────────

const CONVERSATIONAL_ROOT_PATH = "/tmp/pi-conversation";
const CONVERSATIONAL_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const CONVERSATIONAL_TURN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CONVERSATIONAL_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CONVERSATIONAL_MAX_ITERATIONS = 100;
const CONVERSATIONAL_MAX_TOKENS_PER_TURN = 128_000;

// ── Policy input ───────────────────────────────────────────────

/**
 * Partial policy input for constructing a conversational session policy.
 *
 * All fields are optional; sensible defaults are applied by
 * {@link createConversationalPolicy}.
 */
export interface ConversationalPolicyInput {
  /** Correlation ID for event emission and logging. */
  readonly policyId: string;

  // Filesystem
  readonly rootPath?: string;
  readonly allowedPaths?: string[];
  readonly denyPaths?: string[];

  // Tools — conversational always denies WORKER_ONLY_TOOLS
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

// ── Factory ────────────────────────────────────────────────────

/**
 * Create an {@link ExecutionPolicy} for an ordinary conversational session.
 *
 * Merges caller-supplied tool deny list with the always-denied
 * {@link WORKER_ONLY_TOOLS} so worker lifecycle tools can never appear
 * in a conversational tool surface.
 */
export function createConversationalPolicy(
  input: ConversationalPolicyInput,
): ExecutionPolicy {
  const workerDenied = [...WORKER_ONLY_TOOLS];
  const callerDenied = input.deniedTools ?? [];
  const mergedDenied = [...new Set([...workerDenied, ...callerDenied])];

  return createExecutionPolicy({
    policyId: input.policyId,
    rootPath: input.rootPath ?? CONVERSATIONAL_ROOT_PATH,
    allowedPaths: input.allowedPaths,
    denyPaths: input.denyPaths,
    allowedTools: input.allowedTools,
    deniedTools: mergedDenied,
    allowedHosts: input.allowedHosts,
    deniedHosts: input.deniedHosts,
    maxDurationMs: input.maxDurationMs ?? CONVERSATIONAL_TIMEOUT_MS,
    maxTurnDurationMs: input.maxTurnDurationMs ?? CONVERSATIONAL_TURN_TIMEOUT_MS,
    idleTimeoutMs: input.idleTimeoutMs ?? CONVERSATIONAL_IDLE_TIMEOUT_MS,
    maxIterations: input.maxIterations ?? CONVERSATIONAL_MAX_ITERATIONS,
    maxTokensPerTurn: input.maxTokensPerTurn ?? CONVERSATIONAL_MAX_TOKENS_PER_TURN,
    credentialScope: input.credentialScope ?? "none",
  });
}

/**
 * Check whether a tool name is a worker-only tool that must be denied
 * in conversational sessions.
 */
export function isWorkerOnlyTool(toolName: string): boolean {
  return WORKER_ONLY_TOOLS.has(toolName);
}
