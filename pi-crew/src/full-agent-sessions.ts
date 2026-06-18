import type { ChannelBinding, SessionConfig } from "@pi-crew/service";
import { loadProfile } from "@pi-crew/profiles";
import type { CrewConfig } from "./config.js";

export interface ResolvedAgentFields {
  memberIdentity: string;
  profileIdentity: string;
  memberRole: string;
  sessionId: string;
  ownerId: string;
  maxHistoryMessages: number;
  turnTimeoutMs: number | null;
  displayName?: string;
  channels: {
    providerId: string;
    projectId?: string;
    channelId: string;
    subscriptionIdentity: string;
    wakePolicy: "subscription" | "direct_polling";
  }[];
}

export function resolveAgentFields(agent: CrewConfig["fullAgents"][number], profilesRoot: string): ResolvedAgentFields {
  const agentSession = agent.session;
  const agentLifecycle = agent.lifecycle;

  let profile: ReturnType<typeof loadProfile>;
  try {
    profile = loadProfile(agent.profileId, profilesRoot);
  } catch {
    // If profile can't be loaded, resolve with just config and schema defaults
    const fallbackMemberIdentity = agent.memberIdentity ?? agent.agentId;
    const fallbackSessionId = agentSession?.sessionId ?? "sess-" + agent.agentId;
    return {
      memberIdentity: fallbackMemberIdentity,
      profileIdentity: agent.profileIdentity ?? agent.profileId,
      memberRole: agent.memberRole ?? "agent",
      sessionId: fallbackSessionId,
      ownerId: agentSession?.ownerId ?? fallbackMemberIdentity,
      maxHistoryMessages: agentSession?.maxHistoryMessages ?? 100,
      turnTimeoutMs: agentLifecycle?.turnTimeoutMs ?? null,
      channels: agent.channels.map((channel) => ({
        providerId: channel.providerId,
        projectId: channel.projectId,
        channelId: channel.channelId,
        subscriptionIdentity: channel.subscriptionIdentity ?? fallbackMemberIdentity + ":ordinary:" + fallbackSessionId,
        wakePolicy: channel.wakePolicy ?? "subscription",
      })),
    };
  }

  const resolvedMemberIdentity = agent.memberIdentity ?? profile.memberIdentity ?? agent.agentId;
  const resolvedProfileIdentity = agent.profileIdentity ?? profile.profileIdentity ?? agent.profileId;
  const resolvedMemberRole = agent.memberRole ?? profile.memberRole ?? "agent";
  const resolvedSessionId = agentSession?.sessionId ?? "sess-" + agent.agentId;
  const resolvedOwnerId = agentSession?.ownerId ?? profile.sessionDefaults?.ownerId ?? "owner:den-k8plus:" + agent.agentId;
  const resolvedMaxHistoryMessages = agentSession?.maxHistoryMessages ?? profile.sessionDefaults?.maxHistoryMessages ?? 100;
  const resolvedTurnTimeoutMs = agentLifecycle?.turnTimeoutMs ?? profile.sessionDefaults?.turnTimeoutMs ?? null;

  return {
    memberIdentity: resolvedMemberIdentity,
    profileIdentity: resolvedProfileIdentity,
    memberRole: resolvedMemberRole,
    sessionId: resolvedSessionId,
    ownerId: resolvedOwnerId,
    maxHistoryMessages: resolvedMaxHistoryMessages,
    turnTimeoutMs: resolvedTurnTimeoutMs,
    displayName: agent.displayName ?? profile.displayName,
    channels: agent.channels.map((channel) => ({
      providerId: channel.providerId,
      projectId: channel.projectId,
      channelId: channel.channelId,
      subscriptionIdentity: channel.subscriptionIdentity ?? resolvedMemberIdentity + ":ordinary:" + resolvedSessionId,
      wakePolicy: channel.wakePolicy ?? profile.channelDefaults?.wakePolicy ?? "subscription",
    })),
  };
}

export function configuredFullSessionConfigs(config: CrewConfig, profilesRoot: string): readonly SessionConfig[] {
  return config.fullAgents
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const resolved = resolveAgentFields(agent, profilesRoot);
      return {
        sessionId: resolved.sessionId,
        kind: "full" as const,
        profileId: agent.profileId,
        channelBindings: resolved.channels.map((channel): ChannelBinding => ({
          providerId: channel.providerId,
          projectId: channel.projectId,
          channelId: channel.channelId,
          memberIdentity: resolved.memberIdentity,
          profileIdentity: resolved.profileIdentity,
          memberRole: resolved.memberRole,
          subscriptionIdentity: channel.subscriptionIdentity,
          sessionOwnerId: resolved.ownerId,
        })),
        responseTimeoutMs: resolved.turnTimeoutMs,
      };
    });
}

interface ConfigurableFullSessionManager {
  configureFullSessions(configs: readonly SessionConfig[]): void;
}

export function configureFullSessionManager(manager: unknown, config: CrewConfig, profilesRoot: string): void {
  (manager as ConfigurableFullSessionManager).configureFullSessions(
    configuredFullSessionConfigs(config, profilesRoot),
  );
}

export function configuredFullAgentMemberIdentities(config: CrewConfig, profilesRoot: string): readonly string[] {
  return [...new Set(
    config.fullAgents
      .filter((agent) => agent.enabled)
      .map((agent) => resolveAgentFields(agent, profilesRoot).memberIdentity),
  )];
}

export function configuredFullAgentAdditionalProjectIds(config: CrewConfig, profilesRoot: string, primaryProjectId: string): readonly string[] {
  return [...new Set(
    config.fullAgents
      .filter((agent) => agent.enabled)
      .flatMap((agent) => resolveAgentFields(agent, profilesRoot).channels.map((ch) => ch.projectId))
      .filter((pid): pid is string => pid !== undefined && pid !== primaryProjectId),
  )];
}
