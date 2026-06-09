import type {
  EventBus,
  ExecutionPolicy,
  GatewayEvent,
  HookRegistry,
  AfterToolCallModifier,
  WorkerPolicy,
} from "@pi-crew/core";
import {
  scanCredentials,
  scanHosts,
  scanPaths,
  scanToolName,
} from "@pi-crew/tools";
import type { ServiceExtension, ServiceExtensionContext } from "../extension-activator.js";
import type { WorkerBinding } from "../sessions/types.js";

export interface ToolPolicySessionContext {
  readonly binding: WorkerBinding;
  readonly sessionId: string;
  readonly profileId: string;
  readonly policy: WorkerPolicy;
}

export interface ToolPolicySessionRegistry {
  register(context: ToolPolicySessionContext): () => void;
  get(sessionId: string): ToolPolicySessionContext | undefined;
  clear(): void;
}

export class InMemoryToolPolicySessionRegistry implements ToolPolicySessionRegistry {
  readonly #sessions = new Map<string, ToolPolicySessionContext>();

  register(context: ToolPolicySessionContext): () => void {
    this.#sessions.set(context.sessionId, context);
    return () => {
      this.#sessions.delete(context.sessionId);
    };
  }

  get(sessionId: string): ToolPolicySessionContext | undefined {
    return this.#sessions.get(sessionId);
  }

  clear(): void {
    this.#sessions.clear();
  }
}

interface DenialCorrelation {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly profileId: string;
}

const CREDENTIAL_PATTERNS = [
  /(?:api[_-]?key|apikey|secret[_-]?key|private[_-]?key)\s*[:=]\s*\S+/gi,
  /(?:token|password|passwd|credential)\s*[:=]\s*\S+/gi,
  /sk-[a-zA-Z0-9]{16,}/g,
];

export class ToolPolicyExtension implements ServiceExtension {
  readonly id = "tool-policy";
  readonly description = "Registers tool policy before/after hooks for worker sessions.";
  readonly #registry: ToolPolicySessionRegistry;
  readonly #unsubscribers: Array<() => void> = [];

  constructor(registry: ToolPolicySessionRegistry) {
    this.#registry = registry;
  }

  activate(context: ServiceExtensionContext): Promise<void> {
    this.#unsubscribers.push(
      context.hookRegistry.register(
        "before_tool_call",
        (payload) => this.beforeToolCall(context, payload.sessionId, payload.toolName, payload.args),
        { name: "tool-policy.before-tool-call", priority: 10 },
      ),
      context.hookRegistry.register(
        "after_tool_call",
        (payload) => this.afterToolCall(payload.result.content),
        { name: "tool-policy.after-tool-call", priority: 10 },
      ),
    );
    context.logger.info("ToolPolicyExtension activated", { extensionId: this.id });
    return Promise.resolve();
  }

  deactivate(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      unsubscribe();
    }
    return Promise.resolve();
  }

  private beforeToolCall(
    context: ServiceExtensionContext,
    sessionId: string,
    toolName: string,
    args: unknown,
  ): { readonly proceed: true } | { readonly proceed: false; readonly reason: string } {
    const session = this.#registry.get(sessionId);
    if (session === undefined) return { proceed: true };

    const denial = firstDenial(session.policy, toolName, args);
    if (denial === null) return { proceed: true };

    const correlation = toCorrelation(session);
    context.logger.warn("ToolPolicyExtension: before_tool_call denied", {
      toolName,
      reason: denial.reason,
      ...correlation,
    });
    emitPolicyDenial(context.eventBus, correlation, toolName, denial.reason, denial.kind);
    return { proceed: false, reason: denial.reason };
  }

  private afterToolCall(
    content: readonly unknown[],
  ): { readonly contentOverride?: readonly unknown[] } {
    const redacted = redactContent(content);
    if (redacted === null) return {};
    return { contentOverride: redacted };
  }
}

export function registerToolPolicySession(
  registry: ToolPolicySessionRegistry,
  context: ToolPolicySessionContext,
): () => void {
  return registry.register(context);
}

export function createHookBackedToolPolicyHooks(options: {
  readonly hookRegistry: HookRegistry;
  readonly session: ToolPolicySessionContext;
}): {
  beforeToolCall(toolName: string, toolCallId: string, args: unknown): Promise<string | null>;
  afterToolCall(
    content: readonly unknown[],
    toolName: string,
    toolCallId: string,
    args: unknown,
    isError: boolean,
  ): Promise<AfterToolCallModifier | null>;
} {
  return {
    beforeToolCall: async (toolName, toolCallId, args) => {
      const result = await options.hookRegistry.fire("before_tool_call", {
        sessionId: options.session.sessionId,
        toolName,
        toolCallId,
        args,
        assignmentId: options.session.binding.assignmentId,
        runId: options.session.binding.runId,
        taskId: options.session.binding.taskId,
        profileId: options.session.profileId,
      });
      return result.proceed ? null : result.reason;
    },
    afterToolCall: async (content, toolName, toolCallId, args, isError) => {
      const result = await options.hookRegistry.fire("after_tool_call", {
        sessionId: options.session.sessionId,
        toolName,
        toolCallId,
        args,
        result: { content, isError, durationMs: 0 },
        assignmentId: options.session.binding.assignmentId,
        runId: options.session.binding.runId,
        taskId: options.session.binding.taskId,
        profileId: options.session.profileId,
      });
      return hasAfterToolCallModifier(result) ? result : null;
    },
  };
}

function hasAfterToolCallModifier(result: AfterToolCallModifier): boolean {
  return result.contentOverride !== undefined
    || result.isErrorOverride !== undefined
    || result.errorOverride !== undefined
    || result.terminate !== undefined;
}

function firstDenial(
  policy: ExecutionPolicy,
  toolName: string,
  args: unknown,
): { readonly kind: "tool" | "path" | "host" | "credential"; readonly reason: string } | null {
  const toolCheck = scanToolName(policy, toolName);
  if (!toolCheck.allowed) return { kind: "tool", reason: toolCheck.reason };

  if (policy.allowedPaths.length > 0 || policy.denyPaths.length > 0) {
    const pathCheck = scanPaths(policy, args);
    if (!pathCheck.allowed) return { kind: "path", reason: pathCheck.reason };
  }

  if (policy.allowedHosts.length > 0 || policy.deniedHosts.length > 0) {
    const hostCheck = scanHosts(policy, args);
    if (!hostCheck.allowed) return { kind: "host", reason: hostCheck.reason };
  }

  const credentialCheck = scanCredentials(policy, args);
  if (!credentialCheck.allowed) return { kind: "credential", reason: credentialCheck.reason };
  return null;
}

function toCorrelation(context: ToolPolicySessionContext): DenialCorrelation {
  return {
    assignmentId: context.binding.assignmentId,
    runId: context.binding.runId,
    taskId: context.binding.taskId,
    sessionId: context.sessionId,
    profileId: context.profileId,
  };
}

function emitPolicyDenial(
  eventBus: EventBus,
  ctx: DenialCorrelation,
  toolName: string,
  reason: string,
  checkKind: "tool" | "path" | "host" | "credential",
): void {
  eventBus.emit({
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

  eventBus.emit({
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
  } satisfies GatewayEvent);
}

function redactContent(content: readonly unknown[]): readonly unknown[] | null {
  let changed = false;
  const next: unknown[] = [];
  for (const block of content) {
    if (!isTextBlock(block)) {
      next.push(block);
      continue;
    }
    let text = block.text;
    let blockChanged = false;
    for (const pattern of CREDENTIAL_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        pattern.lastIndex = 0;
        text = text.replace(pattern, "[REDACTED]");
        blockChanged = true;
      }
    }
    changed = changed || blockChanged;
    next.push(blockChanged ? { ...block, text } : block);
  }
  return changed ? next : null;
}

function isTextBlock(value: unknown): value is { readonly type: "text"; readonly text: string } {
  return typeof value === "object"
    && value !== null
    && (value as { readonly type?: unknown }).type === "text"
    && typeof (value as { readonly text?: unknown }).text === "string";
}
