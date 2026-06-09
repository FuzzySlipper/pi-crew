import type { AuditEntry } from "@pi-crew/governance";
import { loadConfig, type ChannelBinding, type GatewayConfig } from "@pi-crew/service";
import type { DenCompletionDefaults } from "./den-completion-poster.js";

export function createFallbackChannelBinding(
  config: GatewayConfig,
): ((channelId: string) => ChannelBinding) | null {
  if (config.den.channelsAllowLegacyDirectPolling) return null;
  if (config.den.channelsSubscriptionIdentity.length === 0) return null;
  return (channelId: string): ChannelBinding => ({
    providerId: "den-channels",
    channelId,
    memberIdentity: config.den.channelsMemberIdentity,
    profileIdentity: config.den.channelsProfileIdentity,
    memberRole:
      config.den.channelsMemberRole.length === 0 ? undefined : config.den.channelsMemberRole,
    subscriptionIdentity: config.den.channelsSubscriptionIdentity,
    sessionOwnerId: config.den.channelsSessionOwnerId,
  });
}

export function auditEntryToRecord(entry: AuditEntry): Record<string, unknown> {
  return {
    timestamp: entry.timestamp,
    event: entry.event,
    payload: entry.payload,
    correlation: entry.correlation,
  };
}

export function validateGatewayConfig(raw: unknown): { valid: boolean; errors: string[] } {
  try {
    loadConfig(raw);
    return { valid: true, errors: [] };
  } catch (error: unknown) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function completionDefaultsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): DenCompletionDefaults | undefined {
  const defaults: DenCompletionDefaults = {
    branch: nonEmpty(env["PI_CREW_COMPLETION_BRANCH"]),
    baseCommit: nonEmpty(env["PI_CREW_COMPLETION_BASE_COMMIT"]),
    headCommit: nonEmpty(env["PI_CREW_COMPLETION_HEAD_COMMIT"]),
    testsRun: parseTestsRun(env["PI_CREW_COMPLETION_TESTS_RUN"]),
  };
  return defaults.branch !== undefined ||
    defaults.baseCommit !== undefined ||
    defaults.headCommit !== undefined ||
    defaults.testsRun !== undefined
    ? defaults
    : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseTestsRun(value: string | undefined): readonly string[] | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
