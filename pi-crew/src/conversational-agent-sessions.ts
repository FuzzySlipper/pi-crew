import type { ChannelBinding, SessionConfig } from "@pi-crew/service";
import type { CrewConfig } from "./config.js";

export function configuredConversationalSessionConfigs(config: CrewConfig): readonly SessionConfig[] {
  return config.conversationalAgents
    .filter((agent) => agent.enabled)
    .map((agent) => ({
      sessionId: agent.session.sessionId,
      kind: "conversational" as const,
      profileId: agent.profileId,
      channelBindings: agent.channels.map((channel): ChannelBinding => ({
        providerId: channel.providerId,
        channelId: channel.channelId,
        memberIdentity: agent.memberIdentity,
        profileIdentity: agent.profileIdentity,
        memberRole: agent.memberRole,
        subscriptionIdentity: channel.subscriptionIdentity,
        sessionOwnerId: agent.session.ownerId,
      })),
    }));
}

interface ConfigurableConversationalSessionManager {
  configureConversationalSessions(configs: readonly SessionConfig[]): void;
}

export function configureConversationalSessionManager(manager: unknown, config: CrewConfig): void {
  (manager as ConfigurableConversationalSessionManager).configureConversationalSessions(
    configuredConversationalSessionConfigs(config),
  );
}

export function configuredConversationalMemberIdentities(config: CrewConfig): readonly string[] {
  return [...new Set(config.conversationalAgents.filter((agent) => agent.enabled).map((agent) => agent.memberIdentity))];
}
