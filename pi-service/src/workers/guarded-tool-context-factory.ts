/**
 * Builds the guarded tool context methods for WorkerExecutionContext.
 *
 * Kept separate from worker-runtime.ts to stay under 500 lines.
 *
 * @module pi-service/workers/guarded-tool-context-factory
 */

import type { Logger, EventBus } from "@pi-crew/core";
import type { WorkerBinding, SessionRecord } from "../sessions/types.js";
import type { WorkerRoleConfig } from "./worker-role-config.js";
import {
  createBeforeToolCallHook,
  createAfterToolCallHook,
  assembleGuardedTools,
} from "./guarded-tool-assembly.js";
import type {
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from "./guarded-tool-types.js";
import { buildWorkerPolicy } from "./worker-policy-builder.js";

export interface GuardedToolContextMethods {
  createGuardedToolHooks(): {
    beforeToolCall: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
    afterToolCall: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
  };
  assembleGuardedTools(
    tools: readonly AgentTool[],
    executor: { readonly callTool: (name: string, params: Record<string, unknown>) => Promise<{ ok: boolean; content: readonly unknown[]; error?: string }> } | null,
  ): AgentTool[];
}

export function buildGuardedToolContext(
  binding: WorkerBinding,
  session: SessionRecord,
  profileId: string,
  roleConfig: WorkerRoleConfig | undefined,
  eventBus: EventBus,
  logger: Logger,
): GuardedToolContextMethods {
  return {
    createGuardedToolHooks: (): {
      beforeToolCall: (
        ctx: BeforeToolCallContext,
      ) => Promise<BeforeToolCallResult | undefined>;
      afterToolCall: (
        ctx: AfterToolCallContext,
      ) => Promise<AfterToolCallResult | undefined>;
    } => {
      const policy = buildWorkerPolicy(binding, roleConfig);
      const assemblyConfig = {
        binding,
        sessionId: session.id,
        profileId,
        policy,
        eventBus,
        logger,
      };
      return {
        beforeToolCall: createBeforeToolCallHook(assemblyConfig),
        afterToolCall: createAfterToolCallHook(assemblyConfig),
      };
    },
    assembleGuardedTools: (
      tools: readonly AgentTool[],
      executor: { readonly callTool: (name: string, params: Record<string, unknown>) => Promise<{ ok: boolean; content: readonly unknown[]; error?: string }> } | null,
    ): AgentTool[] => {
      const policy = buildWorkerPolicy(binding, roleConfig);
      return assembleGuardedTools(
        {
          binding,
          sessionId: session.id,
          profileId,
          policy,
          eventBus,
          logger,
        },
        executor,
        tools,
      );
    },
  };
}
