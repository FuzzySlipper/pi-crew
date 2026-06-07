/**
 * Guarded Agent tool assembly for supervised WorkerRuntime.
 *
 * Builds guarded Agent tool wrappers that enforce WorkerPolicy
 * before and during tool execution. Wires beforeToolCall / afterToolCall
 * Agent hooks for policy preflight and result redaction.
 *
 * Policy denial evidence is emitted via EventBus with full Den
 * correlation IDs (assignmentId, runId, taskId, sessionId, profileId).
 *
 * @module pi-service/workers/guarded-tool-assembly
 */

import type { EventBus, Logger, WorkerPolicy } from "@pi-crew/core";
import type { WorkerBinding } from "../sessions/types.js";
import type {
  AgentTool,
  AgentToolResult,
  BeforeToolCallResult,
  BeforeToolCallContext,
  AfterToolCallResult,
  AfterToolCallContext,
  TextContent,
} from "./guarded-tool-types.js";
import { checkFilesystemPathPolicy } from "./guarded-path-policy.js";

// ── ToolExecutor ─────────────────────────────────────────────────

/**
 * Abstraction over tool execution that guarded wrappers call into.
 *
 * The real implementation is the MCP client (`MCPClient.callTool`),
 * but tests inject a fake to verify wrapper behaviour without a
 * live MCP server.
 */
export interface ToolExecutor {
  callTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: readonly unknown[]; error?: string }>;
}

// ── Config ──────────────────────────────────────────────────────

/**
 * Configuration for {@link assembleGuardedTools} and its helpers.
 *
 * Carries Den correlation context and runtime dependencies for
 * policy enforcement and evidence emission.
 */
export interface GuardedToolAssemblyConfig {
  /** Den assignment binding with correlation IDs. */
  readonly binding: WorkerBinding;
  /** Worker session ID for this assignment. */
  readonly sessionId: string;
  /** Resolved profile ID for this worker role. */
  readonly profileId: string;
  /** Worker policy to enforce. */
  readonly policy: WorkerPolicy;
  /** Shared EventBus for emitting policy evidence. */
  readonly eventBus: EventBus;
  /** Logger for lifecycle telemetry. */
  readonly logger: Logger;
}

// ── Denial context ──────────────────────────────────────────────

interface DenialCorrelation {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly profileId: string;
}

// ── Policy check helpers ────────────────────────────────────────

/**
 * Check whether a tool name is allowed by the policy.
 */
function isToolAllowed(policy: WorkerPolicy, toolName: string): { allowed: boolean; reason: string } {
  // Denylist takes absolute precedence
  if (policy.deniedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is explicitly denied by worker policy`,
    };
  }

  // If allowlist is non-empty, only listed tools pass
  if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not in the worker policy allowlist`,
    };
  }

  return { allowed: true, reason: "" };
}

// ── Denial evidence emission ────────────────────────────────────

/**
 * Emit structured policy denial evidence on the EventBus with
 * full Den correlation IDs.
 */
function emitPolicyDenial(
  config: GuardedToolAssemblyConfig,
  ctx: DenialCorrelation,
  toolName: string,
  reason: string,
  checkKind: "tool" | "path" | "host" | "credential",
): void {
  config.eventBus.emit({
    event: "tool.denied",
    payload: {
      toolName,
      sessionId: ctx.sessionId,
      reason,
      assignmentId: ctx.assignmentId,
      runId: ctx.runId,
      taskId: ctx.taskId,
    },
  });

  config.eventBus.emit({
    event: "policy.enforced",
    payload: {
      sessionId: ctx.sessionId,
      checkKind,
      allowed: false,
      detail: reason,
      assignmentId: ctx.assignmentId,
      runId: ctx.runId,
      taskId: ctx.taskId,
    },
  });
}

/**
 * Build correlation context from config.
 */
function denialCtx(config: GuardedToolAssemblyConfig): DenialCorrelation {
  return {
    assignmentId: config.binding.assignmentId,
    runId: config.binding.runId,
    taskId: config.binding.taskId,
    sessionId: config.sessionId,
    profileId: config.profileId,
  };
}

// ══════════════════════════════════════════════════════════════════
// createBeforeToolCallHook
// ══════════════════════════════════════════════════════════════════

/**
 * Create a `beforeToolCall` hook for pi-agent-core Agent.
 *
 * The returned function performs policy preflight checks:
 * 1. Tool name (allowlist / denylist)
 * 2. Args inspection (filesystem paths)
 *
 * On denial, emits `tool.denied` and `policy.enforced` events with
 * full Den correlation IDs and returns `{ block: true, reason }`.
 * The Agent loop will produce an error tool result visible to the
 * model instead of executing the tool.
 *
 * @returns A function suitable for AgentOptions.beforeToolCall.
 */
export function createBeforeToolCallHook(
  config: GuardedToolAssemblyConfig,
): (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> {
  const ctx = denialCtx(config);
  const policy = config.policy;

  return (
    callCtx: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> => {
    const toolName = callCtx.toolCall.name;

    // ── Tool name policy check ──────────────────────────────
    const toolCheck = isToolAllowed(policy, toolName);
    if (!toolCheck.allowed) {
      config.logger.warn("GuardedToolAssembly: beforeToolCall denied (tool policy)", {
        toolName,
        reason: toolCheck.reason,
        ...ctx,
      });
      emitPolicyDenial(config, ctx, toolName, toolCheck.reason, "tool");
      return Promise.resolve({ block: true, reason: toolCheck.reason });
    }

    // ── Path policy check ───────────────────────────────────
    if (policy.allowedPaths.length > 0 || policy.denyPaths.length > 0) {
      const pathCheck = checkFilesystemPathPolicy(policy, callCtx.args);
      if (!pathCheck.allowed) {
        config.logger.warn("GuardedToolAssembly: beforeToolCall denied (path policy)", {
          toolName,
          reason: pathCheck.reason,
          ...ctx,
        });
        emitPolicyDenial(config, ctx, toolName, pathCheck.reason, "path");
        return Promise.resolve({ block: true, reason: pathCheck.reason });
      }
    }

    // Tool is allowed — return undefined (no blocking)
    return Promise.resolve(undefined);
  };
}

// ══════════════════════════════════════════════════════════════════
// createAfterToolCallHook
// ══════════════════════════════════════════════════════════════════

/**
 * Patterns that suggest credential-like content in tool results.
 * These are scanned case-insensitively.
 */
const CREDENTIAL_PATTERNS = [
  /(?:api[_-]?key|apikey|secret[_-]?key|private[_-]?key)\s*[:=]\s*\S+/gi,
  /(?:token|password|passwd|credential)\s*[:=]\s*\S+/gi,
  /sk-[a-zA-Z0-9]{16,}/g,
];

/**
 * Create an `afterToolCall` hook for pi-agent-core Agent.
 *
 * The returned function redacts credential-like content from
 * tool result text before it reaches the model. Clean results
 * pass through unchanged (returns undefined).
 *
 * @returns A function suitable for AgentOptions.afterToolCall.
 */
export function createAfterToolCallHook(
  config: GuardedToolAssemblyConfig,
): (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | undefined> {
  const corrCtx = denialCtx(config);

  return (
    callCtx: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> => {
    // Extract text content
    const content = callCtx.result.content;
    if (content.length === 0) {
      return Promise.resolve(undefined);
    }

    // Single pass: collect indices of blocks needing redaction
    const redactIndices: number[] = [];
    const newContent = content.map((block, idx) => {
      if (block.type === "text") {
        let text = block.text;
        let blockRedacted = false;
        for (const pattern of CREDENTIAL_PATTERNS) {
          if (pattern.test(text)) {
            blockRedacted = true;
            text = text.replace(pattern, "[REDACTED]");
          }
        }
        if (blockRedacted) {
          redactIndices.push(idx);
          return { type: "text" as const, text };
        }
      }
      return block;
    });

    if (redactIndices.length > 0) {
      config.logger.info("GuardedToolAssembly: afterToolCall redacted credential content", {
        toolName: callCtx.toolCall.name,
        ...corrCtx,
      });

      return Promise.resolve({
        content: newContent,
      });
    }

    return Promise.resolve(undefined);
  };
}

// ══════════════════════════════════════════════════════════════════
// Tool wrapper execution
// ══════════════════════════════════════════════════════════════════

/**
 * Build a denial error tool result compatible with pi-agent-core.
 *
 * The model sees this as an error tool result and can reason about
 * the denial rather than being silently blocked.
 */
function buildDenialResult(
  toolName: string,
  reason: string,
): AgentToolResult {
  const text: TextContent = {
    type: "text",
    text: `Tool "${toolName}" execution denied: ${reason}`,
  };
  return {
    content: [text],
    details: { denied: true, reason, toolName },
  };
}

/**
 * Wrap a single tool's execute() with policy enforcement.
 *
 * This is the second line of defense — re-checks policy at dispatch
 * time for tools where pre-flight checks aren't sufficient
 * (e.g., path resolution, host resolution inside the tool).
 *
 * Also handles the case where Agent's beforeToolCall passes through
 * but the wrapper catches it (belt-and-suspenders).
 */
function wrapExecute(
  config: GuardedToolAssemblyConfig,
  executor: ToolExecutor | null,
  toolName: string,
  originalExecute: AgentTool["execute"],
): AgentTool["execute"] {
  const corrCtx = denialCtx(config);
  const policy = config.policy;

  return async (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult) => void,
  ): Promise<AgentToolResult> => {
    // ── Dispatch-time policy re-check ──────────────────────
    const toolCheck = isToolAllowed(policy, toolName);
    if (!toolCheck.allowed) {
      config.logger.warn("GuardedToolAssembly: execute denied (wrapper-level tool policy)", {
        toolName,
        toolCallId,
        reason: toolCheck.reason,
        ...corrCtx,
      });
      emitPolicyDenial(config, corrCtx, toolName, toolCheck.reason, "tool");
      return buildDenialResult(toolName, toolCheck.reason);
    }

    // ── Path re-check at dispatch time ─────────────────────
    if (policy.allowedPaths.length > 0 || policy.denyPaths.length > 0) {
      const pathCheck = checkFilesystemPathPolicy(policy, params);
      if (!pathCheck.allowed) {
        config.logger.warn("GuardedToolAssembly: execute denied (wrapper-level path policy)", {
          toolName,
          toolCallId,
          reason: pathCheck.reason,
          ...corrCtx,
        });
        emitPolicyDenial(config, corrCtx, toolName, pathCheck.reason, "path");
        return buildDenialResult(toolName, pathCheck.reason);
      }
    }

    // ── Delegate to original execute or executor ───────────
    if (executor !== null) {
      // MCP-backed tool: route through ToolExecutor
      const execParams =
        typeof params === "object" && params !== null
          ? (params as Record<string, unknown>)
          : {};
      const result = await executor.callTool(toolName, execParams);

      if (!result.ok) {
        const errorText: TextContent = {
          type: "text",
          text: result.error ?? `Tool "${toolName}" failed`,
        };
        return {
          content: [errorText],
          details: { error: result.error },
        };
      }

      const content = result.content.map((item: unknown) => {
        if (typeof item === "object" && item !== null) {
          const itemObj = item as Record<string, unknown>;
          if (itemObj.type === "text") {
            return { type: "text" as const, text: typeof itemObj.text === "string" ? itemObj.text : "" };
          }
        }
        return { type: "text" as const, text: String(item) };
      });

      return {
        content,
        details: undefined,
      };
    }

    // Self-contained tool: call original execute
    return originalExecute(toolCallId, params, signal, onUpdate);
  };
}

// ══════════════════════════════════════════════════════════════════
// assembleGuardedTools
// ══════════════════════════════════════════════════════════════════

/**
 * Assemble guarded Agent tools for a supervised worker session.
 *
 * Each tool's `execute()` is wrapped with policy enforcement
 * (second-line defense). The resulting tools are suitable for
 * assignment to `agent.state.tools`.
 *
 * Policy enforcement layers:
 * 1. `beforeToolCall` hook (Agent pre-flight) — tool name, path args
 * 2. Wrapper `execute()` (dispatch-time) — re-checks policy at runtime
 * 3. `afterToolCall` hook (Agent post-execution) — result redaction
 *
 * @param config — Assembly configuration with policy and correlation IDs.
 * @param executor — Tool executor for MCP-backed tools; null for self-contained tools.
 * @param tools — The raw pi-agent-core AgentTools to wrap.
 * @returns Wrapped AgentTool[] with policy enforcement.
 */
export function assembleGuardedTools(
  config: GuardedToolAssemblyConfig,
  executor: ToolExecutor | null,
  tools: readonly AgentTool[],
): AgentTool[] {
  return tools.map((tool) => {
    const wrappedExecute = wrapExecute(
      config,
      executor,
      tool.name,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      tool.execute,
    );

    return {
      label: tool.label,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: wrappedExecute,
    };
  });
}
