import type { ChannelBinding, SessionConfig } from "@pi-crew/service";
import type { CrewConfig } from "./config.js";

export function configuredFullSessionConfigs(config: CrewConfig): readonly SessionConfig[] {
  return config.fullAgents
    .filter((agent) => agent.enabled)
    .map((agent) => ({
      sessionId: agent.session.sessionId,
      kind: "full" as const,
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

interface ConfigurableFullSessionManager {
  configureFullSessions(configs: readonly SessionConfig[]): void;
}

export function configureFullSessionManager(manager: unknown, config: CrewConfig): void {
  (manager as ConfigurableFullSessionManager).configureFullSessions(
    configuredFullSessionConfigs(config),
  );
}

export function configuredFullAgentMemberIdentities(config: CrewConfig): readonly string[] {
  return [...new Set(config.fullAgents.filter((agent) => agent.enabled).map((agent) => agent.memberIdentity))];
}
