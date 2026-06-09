/**
 * Typed hook registry for pi-crew runtime interception points.
 *
 * EventBus remains the fire-and-forget observation surface. Hooks are
 * awaited decision points that can gate, modify, or observe runtime actions.
 *
 * @module pi-core/hooks
 */

import type { Logger } from "./logging.js";
import type { DelegationLineage, DelegationSpawnRequest, SessionKind } from "./delegation.js";
import type { CompletionPacket } from "./types.js";

// ── Hook result shapes ─────────────────────────────────────────

/** A gate hook decision. The first veto short-circuits the chain. */
export type GateResult =
  | { readonly proceed: true; readonly reason?: string }
  | { readonly proceed: false; readonly reason: string };

/** Generic modifier pattern: hook-specific fields are partial overrides. */
export interface ModifierResult<T extends object> {
  readonly override?: Partial<T>;
}

/** Observer hooks resolve without returning a decision value. */
export type ObserverResult = undefined;

/** Common optional Den correlation fields for runtime hook payloads. */
export interface HookDenCorrelation {
  readonly assignmentId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly profileId?: string;
}

// ── Payload types ──────────────────────────────────────────────

export interface BeforeToolCallPayload extends HookDenCorrelation {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: unknown;
}

export interface AfterToolCallResultSnapshot {
  readonly content: readonly unknown[];
  readonly isError: boolean;
  readonly durationMs: number;
}

export interface AfterToolCallPayload extends HookDenCorrelation {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: unknown;
  readonly result: AfterToolCallResultSnapshot;
}

export interface AfterToolCallModifier {
  readonly contentOverride?: readonly unknown[];
  readonly isErrorOverride?: boolean;
  readonly errorOverride?: string;
  readonly terminate?: boolean;
}

export interface BeforeAgentStartPayload extends HookDenCorrelation {
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly modelId: string;
}

export interface BeforeAgentStartModifier {
  readonly systemPromptAppend?: string;
  readonly modelOverride?: string;
  readonly additionalTools?: readonly unknown[];
}

export interface AfterAgentStartPayload extends HookDenCorrelation {
  readonly sessionId: string;
  readonly modelId: string;
}

export interface MessageContentSnapshot {
  readonly kind: string;
  readonly text?: string;
}

export interface BeforeMessageSendPayload {
  readonly channelId: string;
  readonly sessionId: string;
  readonly content: MessageContentSnapshot;
}

export interface AfterMessageSendPayload {
  readonly channelId: string;
  readonly sessionId: string;
  readonly messageId: string;
}

export interface BeforeSessionCreatePayload {
  readonly profileId: string;
  readonly kind: SessionKind;
  readonly channelBindings: readonly string[];
  readonly delegation?: DelegationLineage;
  readonly delegationSpawnRequest?: DelegationSpawnRequest;
}

export interface BeforeCompactionPayload extends HookDenCorrelation {
  readonly sessionId: string;
  readonly currentTokenCount: number;
  readonly maxTokens: number;
}

export interface AfterCompactionPayload extends HookDenCorrelation {
  readonly sessionId: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface BeforeCompletionPostPayload extends HookDenCorrelation {
  readonly sessionId: string;
  readonly packet: CompletionPacket;
}

export interface BeforeCompletionPostModifier {
  readonly packetOverrides?: Partial<CompletionPacket>;
}

export interface BeforeDrainActivatePayload extends HookDenCorrelation {
  readonly sessionId: string;
  readonly reason: "iteration_budget" | "context_limit" | "timeout" | "policy";
}

export interface AgentContextInjectPayload extends HookDenCorrelation {
  readonly sessionId: string;
  readonly profileId: string;
  readonly workdir?: string;
}

export interface AgentContextInjectModifier {
  readonly contextAppend?: string;
  readonly env?: Readonly<Record<string, string>>;
}

// ── Catalog types ──────────────────────────────────────────────

interface HookContract<K extends HookKind, P, R> {
  readonly kind: K;
  readonly payload: P;
  readonly result: R;
}

export type HookKind = "gate" | "modifier" | "observer";

export interface HookCatalog {
  readonly before_tool_call: HookContract<"gate", BeforeToolCallPayload, GateResult>;
  readonly after_tool_call: HookContract<"modifier", AfterToolCallPayload, AfterToolCallModifier>;
  readonly before_agent_start: HookContract<"modifier", BeforeAgentStartPayload, BeforeAgentStartModifier>;
  readonly after_agent_start: HookContract<"observer", AfterAgentStartPayload, ObserverResult>;
  readonly before_message_send: HookContract<"gate", BeforeMessageSendPayload, GateResult>;
  readonly after_message_send: HookContract<"observer", AfterMessageSendPayload, ObserverResult>;
  readonly before_session_create: HookContract<"gate", BeforeSessionCreatePayload, GateResult>;
  readonly before_compaction: HookContract<"gate", BeforeCompactionPayload, GateResult>;
  readonly after_compaction: HookContract<"observer", AfterCompactionPayload, ObserverResult>;
  readonly before_completion_post: HookContract<"modifier", BeforeCompletionPostPayload, BeforeCompletionPostModifier>;
  readonly before_drain_activate: HookContract<"gate", BeforeDrainActivatePayload, GateResult>;
  readonly agent_context_inject: HookContract<"modifier", AgentContextInjectPayload, AgentContextInjectModifier>;
}

export type HookName = keyof HookCatalog;
export type HookPayload<H extends HookName> = HookCatalog[H]["payload"];
export type HookReturn<H extends HookName> = HookCatalog[H]["result"];
export type HookHandler<H extends HookName> = HookCatalog[H]["kind"] extends "observer"
  ? (payload: HookPayload<H>) => void | Promise<void>
  : (payload: HookPayload<H>) => HookReturn<H> | Promise<HookReturn<H>>;

export interface HookRegistrationOptions {
  readonly name: string;
  readonly priority?: number;
}

export interface HookRegistry {
  register<H extends HookName>(
    hook: H,
    handler: HookHandler<H>,
    options?: HookRegistrationOptions,
  ): () => void;

  fire<H extends HookName>(hook: H, payload: HookPayload<H>): Promise<HookReturn<H>>;
}

const HOOK_KINDS: { readonly [H in HookName]: HookCatalog[H]["kind"] } = {
  before_tool_call: "gate",
  after_tool_call: "modifier",
  before_agent_start: "modifier",
  after_agent_start: "observer",
  before_message_send: "gate",
  after_message_send: "observer",
  before_session_create: "gate",
  before_compaction: "gate",
  after_compaction: "observer",
  before_completion_post: "modifier",
  before_drain_activate: "gate",
  agent_context_inject: "modifier",
};

interface StoredRegistration {
  readonly hook: HookName;
  readonly handlerName: string;
  readonly priority: number;
  readonly sequence: number;
  readonly handler: (payload: unknown) => unknown;
}

/** In-memory HookRegistry implementation for service composition and tests. */
export class InMemoryHookRegistry implements HookRegistry {
  private readonly registrations = new Map<HookName, StoredRegistration[]>();
  private sequence = 0;

  constructor(private readonly logger: Logger | null = null) {}

  register<H extends HookName>(
    hook: H,
    handler: HookHandler<H>,
    options?: HookRegistrationOptions,
  ): () => void {
    const registration: StoredRegistration = {
      hook,
      handlerName: options?.name ?? hook,
      priority: options?.priority ?? 100,
      sequence: this.sequence,
      handler: (payload: unknown) => handler(payload as HookPayload<H>),
    };
    this.sequence += 1;

    const existing = this.registrations.get(hook) ?? [];
    this.registrations.set(hook, [...existing, registration]);

    return () => {
      this.unregister(registration);
    };
  }

  async fire<H extends HookName>(hook: H, payload: HookPayload<H>): Promise<HookReturn<H>> {
    const kind = HOOK_KINDS[hook];
    if (kind === "gate") {
      return this.fireGate(hook, payload);
    }
    if (kind === "modifier") {
      return this.fireModifier(hook, payload);
    }
    await this.fireObserver(hook, payload);
    return undefined;
  }

  private async fireGate(hook: HookName, payload: unknown): Promise<GateResult> {
    for (const registration of this.sortedRegistrations(hook)) {
      const result = await registration.handler(payload) as GateResult;
      if (!result.proceed) return result;
    }
    return { proceed: true };
  }

  private async fireModifier(hook: HookName, payload: unknown): Promise<Record<string, unknown>> {
    let merged: Record<string, unknown> = {};
    for (const registration of this.sortedRegistrations(hook)) {
      try {
        const result = await registration.handler(payload);
        merged = mergeModifierResult(merged, result);
      } catch (error) {
        this.logHandlerError(hook, registration.handlerName, error);
      }
    }
    return merged;
  }

  private async fireObserver(hook: HookName, payload: unknown): Promise<void> {
    for (const registration of this.sortedRegistrations(hook)) {
      try {
        await registration.handler(payload);
      } catch (error) {
        this.logHandlerError(hook, registration.handlerName, error);
      }
    }
  }

  private sortedRegistrations(hook: HookName): StoredRegistration[] {
    return [...(this.registrations.get(hook) ?? [])].sort((left, right) => {
      const priorityDiff = left.priority - right.priority;
      return priorityDiff !== 0 ? priorityDiff : left.sequence - right.sequence;
    });
  }

  private unregister(registration: StoredRegistration): void {
    const current = this.registrations.get(registration.hook) ?? [];
    const remaining = current.filter((entry) => entry !== registration);
    this.registrations.set(registration.hook, remaining);
  }

  private logHandlerError(hook: HookName, handler: string, error: unknown): void {
    this.logger?.warn("Hook handler failed", {
      hook,
      handler,
      error: describeUnknownError(error),
    });
  }
}

function mergeModifierResult(
  current: Record<string, unknown>,
  next: unknown,
): Record<string, unknown> {
  if (!isRecord(next)) return current;

  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    merged[key] = mergeModifierValue(merged[key], value);
  }
  return merged;
}

function mergeModifierValue(existing: unknown, incoming: unknown): unknown {
  if (typeof existing === "string" && typeof incoming === "string") {
    return existing.length > 0 ? `${existing}\n${incoming}` : incoming;
  }
  if (isUnknownArray(existing) && isUnknownArray(incoming)) {
    return [...existing, ...incoming];
  }
  if (isRecord(existing) && isRecord(incoming)) {
    return { ...existing, ...incoming };
  }
  return incoming;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
