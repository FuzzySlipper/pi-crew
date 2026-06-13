/**
 * LLM-backed delegated child runner: creates a real Agent session for
 * delegated subagent execution.
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
import type {
  DelegatedImplementationResult,
  DelegatedResult,
  DelegatedReviewResult,
  EffectiveDelegationRuntime,
  ExecutionPolicy,
} from "@pi-crew/core";
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
import {
  buildDrainModePrompt,
  selectDrainModeTools,
  turnHadToolResults,
} from "./delegated-child-drain-mode.js";
import { createDelegatedResultPostTools } from "./delegated-result-post-tools.js";
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
  readonly runtimeConfig?: DelegatedRuntimeConfig;
}

export interface DelegatedRuntimeConfig {
  readonly maxIterations?: number;
  readonly maxTokensPerTurn?: number;
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
      const maxIterations = this.#resolveMaxIterations(input, runtimeResolution?.runtimeConfig);
      const model = runtimeResolution?.model ?? this.#resolveModel(resolvedRuntime);
      let postedImplementation: DelegatedImplementationResult | undefined;
      let postedReview: DelegatedReviewResult | undefined;
      const resultPostTools = createDelegatedResultPostTools({
        expectedResultSchema: input.spawnRequest.expectedResultSchema,
        onImplementation: (result) => {
          postedImplementation = result;
        },
        onReview: (result) => {
          postedReview = result;
        },
      });
      const tools = [
        ...(runtimeResolution?.tools ?? this.#resolveTools(toolFilter)),
        ...resultPostTools,
      ];
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
            maxTokens:
              runtimeResolution?.runtimeConfig?.maxTokensPerTurn ?? input.policy.maxTokensPerTurn,
          }),
        sessionId: input.childSession.sessionId,
        initialState: {
          model,
          systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
        },
      });
      let drainModeEntered = false;

      // Track Agent events for token usage, visibility, and bounded execution.
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

          // Enter drain mode at the iteration cap instead of aborting the run.
          // DESIGN: Aborting immediately after a tool-heavy turn can leave no
          // final assistant text to extract, causing implementation/review
          // evidence validation to fail as "missing structured result" even
          // after useful work. Rationale: one no-tool finalization turn gives
          // the child a bounded chance to emit the required contract while
          // preventing additional tool use.
          if (
            maxIterations > 0 &&
            accumulatedTurnCount >= maxIterations &&
            !drainModeEntered &&
            turnHadToolResults(event)
          ) {
            drainModeEntered = true;
            agent.state.tools = selectDrainModeTools(
              tools,
              input.spawnRequest.expectedResultSchema,
            );
            agent.steer({
              role: "user",
              content: buildDrainModePrompt(input.spawnRequest),
              timestamp: Date.now(),
            });
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
        if (needsFinalization(input.spawnRequest, postedImplementation, postedReview)) {
          agent.state.tools = selectDrainModeTools(tools, input.spawnRequest.expectedResultSchema);
          agent.steer({
            role: "user",
            content: buildDrainModePrompt(input.spawnRequest),
            timestamp: Date.now(),
          });
          await agent.waitForIdle();
        }
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
        evidenceChecked: postedImplementation !== undefined || postedReview !== undefined,
        safeExcerpt: assistantText,
        implementation: postedImplementation,
        review: postedReview,
        artifacts:
          postedImplementation !== undefined
            ? [
                ...postedImplementation.artifactHandles,
                ...(postedImplementation.denHandoffHandles ?? []),
              ]
            : postedReview?.evidenceHandles,
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

  #filterChildTools(
    spawnAllowedTools: readonly string[] | undefined,
    policy: ExecutionPolicy,
  ): ChildToolFilterResult {
    const policyTools = policy.allowedTools ?? [];

    if (policyTools.length === 0) {
      return { allowedToolNames: [], deniedToolNames: [...(policy.deniedTools ?? [])] };
    }

    let allowSet: Set<string>;
    if (spawnAllowedTools !== undefined && spawnAllowedTools.length > 0) {
      allowSet = new Set(spawnAllowedTools.filter((t) => policyTools.includes(t)));
    } else {
      allowSet = new Set(policyTools);
    }

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

  #resolveMaxIterations(
    input: DelegatedChildRunInput,
    runtimeConfig: DelegatedRuntimeConfig | undefined,
  ): number {
    return runtimeConfig?.maxIterations ?? input.policy.maxIterations ?? 0;
  }

  #resolveModel(runtime: EffectiveDelegationRuntime) {
    return resolveDelegatedChildModel(runtime, this.#config);
  }
}

function needsFinalization(
  spawnRequest: DelegatedChildRunInput["spawnRequest"],
  implementation: DelegatedImplementationResult | undefined,
  review: DelegatedReviewResult | undefined,
): boolean {
  return (
    (spawnRequest.expectedResultSchema === "implementation" && implementation === undefined) ||
    (spawnRequest.expectedResultSchema === "review" && review === undefined)
  );
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
