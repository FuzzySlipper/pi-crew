/**
 * Builds the guarded tool context methods for WorkerExecutionContext.
 *
 * Kept separate from worker-runtime.ts to stay under 500 lines.
 *
 * @module pi-service/workers/guarded-tool-context-factory
 */

import type { Logger, EventBus, HookRegistry } from "@pi-crew/core";
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
  TextContent,
  ImageContent,
} from "./guarded-tool-types.js";
import { buildWorkerPolicy } from "./worker-policy-builder.js";
import {
  createHookBackedToolPolicyHooks,
  registerToolPolicySession,
  type ToolPolicySessionRegistry,
} from "./tool-policy-extension.js";

export interface GuardedToolContextMethods {
  dispose?(): void;
  createGuardedToolHooks(): {
    beforeToolCall: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
    afterToolCall: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
  };
  assembleGuardedTools(
    tools: readonly AgentTool[],
    executor: { readonly callTool: (name: string, params: Record<string, unknown>) => Promise<{ ok: boolean; content: readonly unknown[]; error?: string }> } | null,
  ): AgentTool[];
}

export interface GuardedToolContextOptions {
  readonly hookRegistry?: HookRegistry;
  readonly toolPolicySessionRegistry?: ToolPolicySessionRegistry;
}

export function buildGuardedToolContext(
  binding: WorkerBinding,
  session: SessionRecord,
  profileId: string,
  roleConfig: WorkerRoleConfig | undefined,
  eventBus: EventBus,
  logger: Logger,
  options: GuardedToolContextOptions = {},
): GuardedToolContextMethods {
  const policy = buildWorkerPolicy(binding, roleConfig);
  const sessionContext = { binding, sessionId: session.id, profileId, policy };
  const unregister = options.toolPolicySessionRegistry === undefined
    ? undefined
    : registerToolPolicySession(options.toolPolicySessionRegistry, sessionContext);
  const hookBacked = options.hookRegistry === undefined
    ? undefined
    : createHookBackedToolPolicyHooks({ hookRegistry: options.hookRegistry, session: sessionContext });
  const assemblyConfig = { binding, sessionId: session.id, profileId, policy, eventBus, logger };

  return {
    dispose: unregister,
    createGuardedToolHooks: (): {
      beforeToolCall: (
        ctx: BeforeToolCallContext,
      ) => Promise<BeforeToolCallResult | undefined>;
      afterToolCall: (
        ctx: AfterToolCallContext,
      ) => Promise<AfterToolCallResult | undefined>;
    } => ({
      beforeToolCall: hookBacked === undefined
        ? createBeforeToolCallHook(assemblyConfig)
        : async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
          const reason = await hookBacked.beforeToolCall(
            ctx.toolCall.name,
            ctx.toolCall.id,
            ctx.args,
          );
          return reason === null ? undefined : { block: true, reason };
        },
      afterToolCall: hookBacked === undefined
        ? createAfterToolCallHook(assemblyConfig)
        : async (ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
          const modifier = await hookBacked.afterToolCall(
            ctx.result.content,
            ctx.toolCall.name,
            ctx.toolCall.id,
            ctx.args,
            ctx.isError,
          );
          if (modifier === null) return undefined;
          if (modifier.errorOverride !== undefined) {
            logger.warn("after_tool_call errorOverride unsupported by Agent bridge", {
              toolName: ctx.toolCall.name,
              toolCallId: ctx.toolCall.id,
            });
          }
          return {
            content: modifier.contentOverride === undefined
              ? undefined
              : coerceToolContent(modifier.contentOverride),
            isError: modifier.isErrorOverride,
            terminate: modifier.terminate,
          };
        },
    }),
    assembleGuardedTools: (
      tools: readonly AgentTool[],
      executor: { readonly callTool: (name: string, params: Record<string, unknown>) => Promise<{ ok: boolean; content: readonly unknown[]; error?: string }> } | null,
    ): AgentTool[] => assembleGuardedTools(assemblyConfig, executor, tools),
  };
}

function coerceToolContent(content: readonly unknown[]): readonly (TextContent | ImageContent)[] {
  return content.flatMap((item) => isToolContent(item) ? [item] : []);
}

function isToolContent(item: unknown): item is TextContent | ImageContent {
  if (typeof item !== "object" || item === null) return false;
  const record = item as { readonly type?: unknown; readonly text?: unknown; readonly data?: unknown; readonly mimeType?: unknown };
  if (record.type === "text") return typeof record.text === "string";
  return record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string";
}
