/**
 * LLM-backed delegated child runner: creates a real Agent session for
 * delegated subagent execution.
 *
 * DESIGN: SessionMaterializedDelegatedChildRunner is the stub that only
 * records visibility events. This runner replaces it with actual LLM-backed
 * execution using pi-ai model resolution and pi-agent-core Agent.
 * Rationale: spawn_subagent should produce real LLM output, not a stub result.
 *
 * DESIGN (#2284): Child tool surface is derived from spawnRequest.allowedTools
 * and policy.allowedTools (intersection), minus deniedTools (union). A tool
 * provider resolves allowed tool names to AgentTool implementations.
 * Rationale: children should only see a bounded subset of parent tools,
 * preventing privilege amplification.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple, type Api, type Model } from "@earendil-works/pi-ai";
import type { DelegatedResult, EffectiveDelegationRuntime, ExecutionPolicy } from "@pi-crew/core";
import type {
  DelegatedChildRunInput,
  DelegatedChildRunner,
  DelegatedChildRuntimeResolveInput,
} from "./delegated-spawn-lifecycle.js";
import {
  appendImplementationResultInstructions,
  attachExtractedImplementationResult,
} from "./delegated-implementation-result-extraction.js";
import {
  appendReviewResultInstructions,
  attachExtractedReviewResult,
  latestAssistantText,
} from "./delegated-review-result-extraction.js";
import { resolveDelegatedChildModel } from "./llm-delegated-child-model-resolution.js";

const USAGE_ACCUMULATION_INTERVAL_MS = 50;

export interface LlmDelegatedChildRunnerConfig {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly modelName?: string;

  /**
   * Tool provider for resolving allowed tool names to AgentTool instances.
   *
   * DESIGN: The runner does not own tool implementations. It receives
   * allowed tool names from the spawn policy and resolves them via this
   * provider. This keeps the runner agnostic of specific tool implementations
   * and prevents granting ambient tools.
   *
   * When omitted or when provider returns empty, the child runs without tools
   * (prompt-only, single-turn — backward compatible with current behavior).
   */
  readonly toolProvider?: ToolProvider;
  readonly runtimeResolver?: DelegatedChildRuntimeResolver;
}

export interface DelegatedChildRuntimeResolutionInput {
  readonly effectiveRuntime: EffectiveDelegationRuntime;
  readonly spawnRequest: DelegatedChildRunInput["spawnRequest"];
  readonly policy: ExecutionPolicy;
  readonly toolFilter: ChildToolFilterResult;
}

export interface DelegatedChildRuntimeResolution {
  readonly systemPrompt?: string;
  readonly model?: Model<Api>;
  readonly tools?: readonly AgentTool[];
  readonly apiKey?: string;
  readonly effectiveRuntime?: EffectiveDelegationRuntime;
}

export interface DelegatedChildRuntimeResolver {
  resolve(input: DelegatedChildRuntimeResolutionInput): Promise<DelegatedChildRuntimeResolution>;
}

/**
 * Resolves a list of tool names to AgentTool instances.
 *
 * DESIGN: Each tool name maps to zero or one AgentTool. Unknown names are
 * silently skipped, allowing the provider to only expose tools it can
 * safely implement. Rationale: fail-safe — if a tool name is unrecognized,
 * the child simply doesn't get it, rather than erroring out.
 */
export interface ToolProvider {
  resolveTools(toolNames: readonly string[]): AgentTool[];
}

/**
 * Result of filtering spawn request + policy for allowed child tools.
 *
 * DESIGN: The intersection of spawnRequest.allowedTools and
 * policy.allowedTools provides the maximal allowlist. deniedTools from
 * both sources are subtracted. Rationale: a child tool surface is never
 * broader than the parent's policy — it's always a subset.
 */
export interface ChildToolFilterResult {
  readonly allowedToolNames: string[];
  readonly deniedToolNames: string[];
}

export class LlmDelegatedChildRunner implements DelegatedChildRunner {
  readonly #config: LlmDelegatedChildRunnerConfig;

  constructor(config: LlmDelegatedChildRunnerConfig = {}) {
    this.#config = config;
  }

  async resolveEffectiveRuntime(
    input: DelegatedChildRuntimeResolveInput,
  ): Promise<EffectiveDelegationRuntime> {
    const toolFilter = this.#filterChildTools(input.spawnRequest.allowedTools, input.policy);
    const runtimeResolution = await this.#config.runtimeResolver?.resolve({
      effectiveRuntime: input.effectiveRuntime,
      spawnRequest: input.spawnRequest,
      policy: input.policy,
      toolFilter,
    });
    return runtimeResolution?.effectiveRuntime ?? input.effectiveRuntime;
  }

  async run(input: DelegatedChildRunInput): Promise<DelegatedResult> {
    const startedAt = Date.now();
    let accumulatedTokens = 0;
    let accumulatedTurnCount = 0;
    const toolStartTimes = new Map<string, number>();
    const actualToolsUsed = new Set<string>();
    let lastTurnTimestamp = startedAt;
    let maxIterations = this.#resolveMaxIterations(input);

    await input.emitTurnVisible({
      turnNumber: 1,
      phase: "started",
      durationMs: undefined,
      error: undefined,
    });

    try {
      const toolFilter = this.#filterChildTools(input.spawnRequest.allowedTools, input.policy);
      const runtimeResolution = await this.#config.runtimeResolver?.resolve({
        effectiveRuntime: input.effectiveRuntime,
        spawnRequest: input.spawnRequest,
        policy: input.policy,
        toolFilter,
      });
      const resolvedRuntime = runtimeResolution?.effectiveRuntime ?? input.effectiveRuntime;
      const model = runtimeResolution?.model ?? this.#resolveModel(resolvedRuntime);
      const tools = [...(runtimeResolution?.tools ?? this.#resolveTools(toolFilter))];
      const systemPrompt = buildChildSystemPrompt(
        resolvedRuntime,
        toolFilter,
        input.spawnRequest,
        runtimeResolution?.systemPrompt,
      );

      const agent = new Agent({
        getApiKey: () =>
          runtimeResolution?.apiKey ??
          this.#config.apiKey ??
          (this.#config.baseUrl !== undefined ? "unused" : undefined),
        streamFn: (m, context, options) =>
          streamSimple(m, context, {
            ...options,
            temperature: 0.3,
            maxTokens: 2048,
          }),
        sessionId: input.childSession.sessionId,
        initialState: {
          model,
          systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
        },
      });

      // Subscribe to Agent events for token usage, turn tracking,
      // and progress visibility (#2285, #2286)
      // DESIGN (#2286): The Agent loop handles multi-turn automatically.
      // We subscribe to turn_end events to track iteration count,
      // emit progress to the parent, and enforce hard bounds
      // (maxIterations, no-progress detection).
      const unsubscribe = agent.subscribe((event: AgentEvent, signal: AbortSignal) => {
        if (signal.aborted) return;

        if (event.type === "message_end") {
          const msg = event.message as { role?: string; usage?: { totalTokens?: number } };
          if (msg.role === "assistant" && msg.usage?.totalTokens !== undefined) {
            accumulatedTokens += msg.usage.totalTokens;
          }
        }

        if (event.type === "tool_execution_start") {
          actualToolsUsed.add(event.toolName);
          toolStartTimes.set(event.toolCallId, Date.now());
          input
            .emitToolVisible({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              phase: "called",
            })
            .catch(() => {});
        }

        if (event.type === "tool_execution_end") {
          const started = toolStartTimes.get(event.toolCallId);
          toolStartTimes.delete(event.toolCallId);
          input
            .emitToolVisible({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              phase: event.isError ? "denied" : "completed",
              durationMs: started === undefined ? undefined : Date.now() - started,
              reason: event.isError ? "tool execution failed" : undefined,
            })
            .catch(() => {});
        }

        if (event.type === "turn_end") {
          accumulatedTurnCount += 1;
          const now = Date.now();
          const turnDuration = now - lastTurnTimestamp;
          lastTurnTimestamp = now;

          // Emit progress on each turn (#2286)
          input
            .emitTurnVisible({
              turnNumber: accumulatedTurnCount,
              phase: "completed" as const,
              durationMs: turnDuration,
              error: undefined,
            })
            .catch(() => {});

          // Enforce max iterations (#2286)
          if (maxIterations > 0 && accumulatedTurnCount >= maxIterations) {
            agent.abort();
          }
        }
      });

      const taskMessage: AgentMessage = {
        role: "user",
        content: buildChildTaskPrompt(input.spawnRequest.task, input.spawnRequest),
        timestamp: Date.now(),
      };

      try {
        await agent.prompt([taskMessage]);
        await agent.waitForIdle();
      } finally {
        unsubscribe();
      }

      const durationMs = Date.now() - startedAt;

      await input.emitTurnVisible({
        turnNumber: 1,
        phase: "completed",
        durationMs,
        error: undefined,
      });

      const assistantText = latestAssistantText(agent.state.messages);
      const baseResult: DelegatedResult = {
        outcome: "success",
        summary: `Delegated child completed task: ${input.spawnRequest.task.slice(0, 200)}`,
        policyId: input.policy.policyId,
        childSessionId: input.childSession.sessionId,
        effectiveRuntime: resolvedRuntime,
        turnsUsed: accumulatedTurnCount > 0 ? accumulatedTurnCount : 1,
        tokensConsumed: accumulatedTokens,
        durationMs,
        toolsUsed: [...actualToolsUsed],
        evidenceChecked: false,
        safeExcerpt: assistantText,
      };
      return attachExtractedImplementationResult(
        attachExtractedReviewResult(baseResult, input.spawnRequest, assistantText),
        input.spawnRequest,
        assistantText,
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);

      await input.emitTurnVisible({
        turnNumber: 1,
        phase: "completed",
        durationMs,
        error: errorMessage,
      });

      return {
        outcome: "failure",
        summary: `Delegated child failed: ${errorMessage}`,
        policyId: input.policy.policyId,
        childSessionId: input.childSession.sessionId,
        effectiveRuntime: input.effectiveRuntime,
        turnsUsed: 1,
        tokensConsumed: 0,
        durationMs,
        error: errorMessage,
        failureCategory: "execution_error",
      };
    }
  }

  /**
   * Filter tool names from spawn request and policy.
   *
   * Rules:
   * - If policy.allowedTools is empty, the child gets no tools
   *   (a child never has more permissions than its policy allows)
   * - Spawn request allowedTools is intersected with policy.allowedTools
   * - If spawn request does not specify allowedTools, use policy.allowedTools
   * - deniedTools = union of policy.deniedTools; spawn request deniedTools
   *   are also applied when present
   * - Allowed list minus denied list = final surface
   */
  #filterChildTools(
    spawnAllowedTools: readonly string[] | undefined,
    policy: ExecutionPolicy,
  ): ChildToolFilterResult {
    const policyTools = policy.allowedTools ?? [];

    // If policy allows no tools, child gets no tools
    if (policyTools.length === 0) {
      return { allowedToolNames: [], deniedToolNames: [...(policy.deniedTools ?? [])] };
    }

    // Compute allowlist: intersection of spawn request and policy
    let allowSet: Set<string>;
    if (spawnAllowedTools !== undefined && spawnAllowedTools.length > 0) {
      // Intersection: child can only use tools the policy AND spawn request allow
      allowSet = new Set(spawnAllowedTools.filter((t) => policyTools.includes(t)));
    } else {
      // No spawn request restriction, use full policy allowlist
      allowSet = new Set(policyTools);
    }

    // Remove denied tools (union of both sources)
    const spawnDenied = spawnAllowedTools !== undefined ? inputDeniedTools() : [];
    const policyDenied = policy.deniedTools ?? [];
    const denySet = new Set([...spawnDenied, ...policyDenied]);

    for (const denied of denySet) {
      allowSet.delete(denied);
    }

    return {
      allowedToolNames: [...allowSet],
      deniedToolNames: [...denySet],
    };
  }

  /** Resolve allowed tool names to AgentTool implementations via provider. */
  #resolveTools(filter: ChildToolFilterResult): AgentTool[] {
    if (filter.allowedToolNames.length === 0) return [];
    const provider = this.#config.toolProvider;
    if (provider === undefined) return [];
    return provider.resolveTools(filter.allowedToolNames);
  }

  /**
   * Resolve max iterations for the child run.
   *
   * DESIGN: Reads from policy.maxIterations (the child's derived cap)
   * and spawnRequest's implicit max. The hard limit prevents unbounded
   * tool-calling loops. Zero means unlimited (with timeout only).
   * Rationale: a delegated child should never exceed its policy budget.
   */
  #resolveMaxIterations(input: DelegatedChildRunInput): number {
    const policyMax = input.policy.maxIterations;
    if (policyMax !== undefined && policyMax > 0) return policyMax;
    // Default fallback: 10 iterations if policy doesn't specify
    return 10;
  }

  #resolveModel(runtime: EffectiveDelegationRuntime) {
    return resolveDelegatedChildModel(runtime, this.#config);
  }
}

function buildChildTaskPrompt(
  task: string,
  spawnRequest: DelegatedChildRunInput["spawnRequest"],
): string {
  return appendImplementationResultInstructions(
    appendReviewResultInstructions(task, spawnRequest),
    spawnRequest,
  );
}

/** Extract denied tools from the spawn request's deniedTools. */
function inputDeniedTools(): string[] {
  // This exists as a helper to be replaced with actual spawn request denied
  // field lookup when the parent explicitly denies tools. In v1, deniedTools
  // are primarily from policy.
  return [];
}

function buildChildSystemPrompt(
  runtime: EffectiveDelegationRuntime,
  toolFilter: ChildToolFilterResult,
  spawnRequest: { readonly expectedResultSchema?: string; readonly requiredEvidence?: unknown },
  profileSystemPrompt?: string,
): string {
  const parts: string[] =
    profileSystemPrompt !== undefined && profileSystemPrompt.trim().length > 0
      ? [
          profileSystemPrompt.trim(),
          "## Delegation Runtime Instructions",
          "You are running as a delegated subagent executing a specific task for a parent session.",
          "Complete the delegated task concisely and return the required result shape.",
        ]
      : [
          "You are a delegated subagent executing a specific task.",
          "Complete the task concisely and return the result.",
        ];
  parts.push(
    `Profile: ${runtime.profileId}`,
    runtime.provider !== undefined ? `Provider: ${runtime.provider}` : "",
    runtime.model !== undefined ? `Model: ${runtime.model}` : "",
  );

  if (toolFilter.allowedToolNames.length > 0) {
    parts.push(`\nAllowed tools: ${toolFilter.allowedToolNames.join(", ")}`);
  }

  if (toolFilter.deniedToolNames.length > 0) {
    parts.push(`\nDenied tools: ${toolFilter.deniedToolNames.join(", ")}`);
  }

  if (
    spawnRequest.expectedResultSchema === "review" ||
    spawnRequest.requiredEvidence !== undefined
  ) {
    parts.push(
      "\nReview-mode output is mandatory: final answer must contain exactly one <delegated_review_result> JSON object with status, evidenceHandles, taskDecisions, and optional findings. Do not rely on prose summaries for review results.",
    );
  }

  if (spawnRequest.expectedResultSchema === "implementation") {
    parts.push(
      "\nImplementation-mode output is mandatory: final answer must contain exactly one <delegated_implementation_result> JSON object with status, taskId, branch/headCommit or noCodeChangeRationale, changedFiles/artifactHandles, checks, workdirStatus, and optional denHandoffHandles. Do not rely on prose summaries for implementation results.",
    );
  }

  return parts.filter(Boolean).join("\n");
}

export type { DelegatedChildRunInput };
