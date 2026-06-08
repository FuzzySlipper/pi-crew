/**
 * Installs guarded tools and policy hooks on a supervised Agent instance.
 *
 * WorkerRuntime calls this from its AgentSupervisor construction path so
 * policy enforcement is bound to the actual Agent state/options surface,
 * not only exposed as helper methods on WorkerExecutionContext.
 *
 * @module pi-service/workers/guarded-agent-installer
 */

import type { AgentLike, AgentToolRef } from "./agent-supervisor.js";
import type { GuardedToolContextMethods } from "./guarded-tool-context-factory.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "./guarded-tool-types.js";
import type { ToolExecutor } from "./guarded-tool-assembly.js";

export interface GuardedAgentLike extends AgentLike {
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

export interface CheckpointToolHooks {
  afterToolCall(context: AfterToolCallContext): AfterToolCallResult | undefined;
}

/**
 * Attach guarded hooks and wrap the Agent's current tool surface.
 *
 * DESIGN: Only wrap when every state tool has the full AgentTool execute
 * contract. Rationale: drain-mode tests and future telemetry-only fakes may
 * expose name-only tool refs; those can still receive hooks, but wrapping a
 * partial ref would create a fake executable tool and hide wiring bugs.
 */
export function installGuardedAgentRuntime(
  agent: GuardedAgentLike,
  context: GuardedToolContextMethods,
  executor: ToolExecutor | null,
  checkpointHooks?: CheckpointToolHooks,
): void {
  const hooks = context.createGuardedToolHooks();
  agent.beforeToolCall = (hookContext, signal) => {
    void signal;
    return hooks.beforeToolCall(hookContext);
  };
  agent.afterToolCall = async (hookContext, signal) => {
    void signal;
    const guarded = await hooks.afterToolCall(hookContext);
    const checkpoint = checkpointHooks?.afterToolCall(hookContext);
    return mergeAfterToolCallResults(guarded, checkpoint);
  };

  const state = agent.state;
  if (!state) return;

  const rawTools = state.tools;
  if (!rawTools.every(isFullAgentTool)) return;

  state.tools = context.assembleGuardedTools(rawTools, executor);
}

function mergeAfterToolCallResults(
  first: AfterToolCallResult | undefined,
  second: AfterToolCallResult | undefined,
): AfterToolCallResult | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return {
    content: second.content ?? first.content,
    details: second.details ?? first.details,
    isError: second.isError ?? first.isError,
    terminate: second.terminate ?? first.terminate,
  };
}

function isFullAgentTool(tool: AgentToolRef): tool is AgentTool {
  const candidate = tool as unknown as {
    readonly label?: unknown;
    readonly description?: unknown;
    readonly parameters?: unknown;
    readonly execute?: unknown;
  };

  return (
    typeof candidate.label === "string" &&
    typeof candidate.description === "string" &&
    "parameters" in candidate &&
    typeof candidate.execute === "function"
  );
}
