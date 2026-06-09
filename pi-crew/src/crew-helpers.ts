import type { AuditEntry } from "@pi-crew/governance";
import { loadConfig, type ChannelBinding, type GatewayConfig } from "@pi-crew/service";

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
