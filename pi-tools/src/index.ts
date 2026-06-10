// pi-tools — Purpose-built tool implementations for pi-crew agents.
// Depends on: pi-core
//
// This barrel re-exports every public symbol from the individual
// source modules so consumers can write:
//
//   import { createWorkerPolicy, SessionToolFilter } from "@pi-crew/tools";

import type { Result } from "@pi-crew/core";

// ── Existing tool registry (preserved) ───────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<Result<unknown>>;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): string[];
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      tools.set(tool.name, tool);
    },
    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },
    list(): string[] {
      return [...tools.keys()];
    },
  };
}

// ── Execution policy ──────────────────────────────────────────
export {
  type ExecutionPolicyInput,
  type WorkerPolicyInput,
  type CredentialAccessLevel,
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

// ── Policy scanner ────────────────────────────────────────────
export {
  isHostAllowedByPolicy,
  scanCredentials,
  scanHosts,
  scanPaths,
  scanToolName,
} from "./policy-scanner.js";

// ── Delegation policy derivation ───────────────────────────────
export {
  type DelegationPolicyConstraints,
  type DeriveChildExecutionPolicyInput,
  type DelegationPolicyDerivation,
  type DelegationPolicyDerivationErrorCode,
  type DelegationPolicyDerivationError,
  deriveChildExecutionPolicy,
} from "./delegation-policy.js";

// ── Tool policy enforcer ──────────────────────────────────────

export {
  type ToolFilterResult,
  ToolPolicyEnforcer,
} from "./tool-policy-enforcer.js";

// ── Drain mode ────────────────────────────────────────────────

export { DrainModeManager } from "./drain-mode.js";

// ── Context status tool ───────────────────────────────────────

export {
  type ContextUsageTracker,
  type ContextStatusConfig,
  ContextUsageTrackerImpl,
  TokenPressureEmitter,
  contextStatusTool,
} from "./context-status.js";

// ── Post structured completion ────────────────────────────────

export {
  type ValidationErrors,
  type CompletionPoster,
  type CompletionPacketInput,
  validateCompletionPacket,
  postStructuredCompletion,
  buildCompletionPacket,
} from "./post-structured-completion.js";

// ── Checkpoint requests ───────────────────────────────────────

export {
  type CheckpointPacket,
  type CheckpointPoster,
  type CheckpointRuntimeState,
  type PostedCheckpoint,
  createCheckpointState,
  requestCheckpointTool,
} from "./request-checkpoint.js";

// ── Session tool filter ───────────────────────────────────────

export { SessionToolFilter } from "./session-tool-filter.js";

// ── Conversational policy ─────────────────────────────────────

export {
  type ConversationalPolicyInput,
  createConversationalPolicy,
  WORKER_ONLY_TOOLS,
  isWorkerOnlyTool,
} from "./conversational-policy.js";
