import type { ChannelMessage } from "@pi-crew/core";
import type { ChannelBinding, SessionConfig, SessionRecord } from "./types.js";
import { isChannelBindingRecord, channelBindingId } from "./session-channel-bindings.js";

export interface ConfiguredFullSession {
  readonly sessionId: string;
  readonly profileId: string;
  readonly channelBindings: readonly ChannelBinding[];
}

export function normalizeConfiguredFullSessions(
  configs: readonly SessionConfig[],
): readonly ConfiguredFullSession[] {
  return configs
    .filter((config) => config.kind === "full" && config.sessionId !== undefined)
    .map((config) => ({
      sessionId: config.sessionId ?? "",
      profileId: config.profileId,
      channelBindings: config.channelBindings ?? [],
    }));
}

export function findConfiguredFullSession(
  configs: readonly ConfiguredFullSession[],
  message: ChannelMessage,
): ConfiguredFullSession | null {
  const metadata = message.metadata ?? {};
  const sessionId = stringMetadata(metadata, "sessionId");
  if (sessionId !== undefined) {
    return configs.find((config) => config.sessionId === sessionId) ?? null;
  }
  const memberIdentity = stringMetadata(metadata, "memberIdentity") ?? stringMetadata(metadata, "targetMemberIdentity");
  const subscriptionIdentity = stringMetadata(metadata, "subscriptionIdentity");
  const profileIdentity = stringMetadata(metadata, "profileIdentity");
  return (
    configs.find((config) =>
      config.channelBindings.some(
        (binding) =>
          channelBindingId(binding) === message.channelId &&
          bindingMatchesMetadata(binding, { memberIdentity, profileIdentity, subscriptionIdentity }),
      ),
    ) ?? null
  );
}

export function sessionConfigFromConfigured(
  config: ConfiguredFullSession,
): SessionConfig {
  return {
    sessionId: config.sessionId,
    kind: "full",
    profileId: config.profileId,
    channelBindings: [...config.channelBindings],
  };
}

export function configuredSessionMatchesRecord(
  configured: ConfiguredFullSession,
  record: SessionRecord,
): boolean {
  return record.id === configured.sessionId && record.kind === "full";
}

function bindingMatchesMetadata(
  binding: ChannelBinding,
  metadata: {
    readonly memberIdentity?: string;
    readonly profileIdentity?: string;
    readonly subscriptionIdentity?: string;
  },
): boolean {
  if (!isChannelBindingRecord(binding)) return false;
  if (metadata.memberIdentity !== undefined) {
    return binding.memberIdentity === metadata.memberIdentity;
  }
  if (metadata.subscriptionIdentity !== undefined) {
    return binding.subscriptionIdentity === metadata.subscriptionIdentity;
  }
  if (metadata.profileIdentity !== undefined) {
    return binding.profileIdentity === metadata.profileIdentity;
  }
  return false;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
