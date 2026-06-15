/** Full-agent context-window policy and conservative usage estimator. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ContextLengthSource = "den-router" | "config-default" | "unknown-default";

export interface FullAgentContextPolicy {
  readonly contextLength: number;
  readonly contextLengthSource: ContextLengthSource;
  readonly thresholdPercent: number;
  readonly minimumRecentMessages: number;
}

export interface FullAgentContextUsageEstimate {
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly thresholdTokens: number;
  readonly thresholdPercent: number;
  readonly estimationMethod: "chars_div_3";
  readonly contextLengthSource: ContextLengthSource;
}

const CHARS_PER_TOKEN = 3;

export function estimateContextUsage(
  messages: readonly AgentMessage[],
  policy: FullAgentContextPolicy,
): FullAgentContextUsageEstimate {
  const chars = messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
  const usedTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const thresholdTokens = Math.floor((policy.contextLength * policy.thresholdPercent) / 100);
  return {
    usedTokens,
    maxTokens: policy.contextLength,
    thresholdTokens,
    thresholdPercent: policy.thresholdPercent,
    estimationMethod: "chars_div_3",
    contextLengthSource: policy.contextLengthSource,
  };
}

export function shouldCompactContext(estimate: FullAgentContextUsageEstimate): boolean {
  return estimate.usedTokens >= estimate.thresholdTokens;
}
