import type {
  EventBus,
  EventPayload,
  Logger,
} from "@pi-crew/core";
import {
  isChannelMembershipProvider,
  isChannelPresenceProvider,
} from "@pi-crew/core";

type SessionPresencePayload = EventPayload<"session.presence">;

interface PresenceIdentity {
  readonly channelId: string;
  readonly memberIdentity: string;
  readonly subscriptionIdentity: string;
}

/**
 * Translates non-chat session lifecycle events into optional channel presence updates.
 */
export class SessionPresenceBridge {
  constructor(
    eventBus: EventBus,
    private readonly provider: unknown,
    private readonly logger: Logger,
  ) {
    eventBus.on("session.presence", (payload) => {
      void this.apply(payload).catch((error: unknown) => {
        this.logger.warn("Session presence bridge update failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: payload.sessionId,
          reason: payload.reason,
        });
      });
    });
  }

  private async apply(payload: SessionPresencePayload): Promise<void> {
    const identity = readPresenceIdentity(payload);
    if (identity === null) return;

    if (payload.reason === "archived") {
      await this.markLeft(payload, identity);
      return;
    }

    if (payload.subscriptionStatus === "active") {
      await this.upsertActive(payload, identity);
      return;
    }

    await this.updateStatus(payload, identity);
  }

  private async upsertActive(
    payload: SessionPresencePayload,
    identity: PresenceIdentity,
  ): Promise<void> {
    if (!isChannelMembershipProvider(this.provider)) return;
    const membershipResult = this.provider.upsertMembership({
      channelId: identity.channelId,
      memberIdentity: identity.memberIdentity,
      memberType: "agent",
      profileIdentity: payload.channelBinding.profileIdentity ?? payload.profileId,
      memberRole: payload.channelBinding.memberRole,
      status: payload.membershipStatus ?? "active",
      wakePolicy: "subscription",
    });
    const subscriptionResult = this.provider.upsertSubscription({
      channelId: identity.channelId,
      memberIdentity: identity.memberIdentity,
      subscriptionIdentity: identity.subscriptionIdentity,
      purpose: "ordinary_channel",
      status: payload.subscriptionStatus,
      profileIdentity: payload.channelBinding.profileIdentity ?? payload.profileId,
      agentInstanceId: payload.agentInstanceId ?? undefined,
      sessionOwnerId: payload.channelBinding.sessionOwnerId,
      sessionId: payload.sessionId,
    });
    await membershipResult;
    await subscriptionResult;
  }

  private async updateStatus(
    payload: SessionPresencePayload,
    identity: PresenceIdentity,
  ): Promise<void> {
    if (isChannelPresenceProvider(this.provider)) {
      await this.provider.updateSubscriptionStatus({
        channelId: identity.channelId,
        subscriptionIdentity: identity.subscriptionIdentity,
        status: payload.subscriptionStatus,
        lastSeenAt: new Date(),
      });
      return;
    }
    if (isChannelMembershipProvider(this.provider)) {
      await this.provider.upsertSubscription({
        channelId: identity.channelId,
        memberIdentity: identity.memberIdentity,
        subscriptionIdentity: identity.subscriptionIdentity,
        purpose: "ordinary_channel",
        status: payload.subscriptionStatus,
        profileIdentity: payload.channelBinding.profileIdentity ?? payload.profileId,
        agentInstanceId: payload.agentInstanceId ?? undefined,
        sessionOwnerId: payload.channelBinding.sessionOwnerId,
        sessionId: payload.sessionId,
      });
    }
  }

  private async markLeft(
    payload: SessionPresencePayload,
    identity: PresenceIdentity,
  ): Promise<void> {
    if (!isChannelMembershipProvider(this.provider)) return;
    await this.provider.upsertMembership({
      channelId: identity.channelId,
      memberIdentity: identity.memberIdentity,
      memberType: "agent",
      profileIdentity: payload.channelBinding.profileIdentity ?? payload.profileId,
      memberRole: payload.channelBinding.memberRole,
      status: "left",
      wakePolicy: "none",
    });
    await this.provider.releaseSubscription({
      channelId: identity.channelId,
      subscriptionIdentity: identity.subscriptionIdentity,
      status: "offline",
    });
  }
}

function readPresenceIdentity(payload: SessionPresencePayload): PresenceIdentity | null {
  const memberIdentity = payload.channelBinding.memberIdentity;
  const subscriptionIdentity = payload.channelBinding.subscriptionIdentity;
  if (memberIdentity === undefined || subscriptionIdentity === undefined) return null;
  return {
    channelId: payload.channelBinding.channelId,
    memberIdentity,
    subscriptionIdentity,
  };
}
