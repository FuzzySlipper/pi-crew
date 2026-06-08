import { FakeChannelProvider } from "./fake-channel-provider.js";
import type {
  ChannelMembership,
  ChannelMembershipProvider,
  ChannelMembershipUpsert,
  ChannelPresence,
  ChannelPresenceProvider,
  ChannelPresenceQuery,
  ChannelPresenceState,
  ChannelSubscription,
  ChannelSubscriptionRelease,
  ChannelSubscriptionStatus,
  ChannelSubscriptionStatusUpdate,
  ChannelSubscriptionUpsert,
} from "../channel-presence.js";

export class FakeMembershipChannelProvider
  extends FakeChannelProvider
  implements ChannelMembershipProvider, ChannelPresenceProvider {
  public readonly memberships = new Map<string, ChannelMembership>();
  public readonly subscriptions = new Map<string, ChannelSubscription>();

  upsertMembership(input: ChannelMembershipUpsert): Promise<ChannelMembership> {
    const existing = this.memberships.get(membershipKey(input.channelId, input.memberIdentity));
    const membership: ChannelMembership = {
      ...input,
      membershipId: existing?.membershipId ?? `membership:${input.channelId}:${input.memberIdentity}`,
      status: input.status ?? existing?.status ?? "active",
      updatedAt: new Date(),
    };
    this.memberships.set(membershipKey(input.channelId, input.memberIdentity), membership);
    return Promise.resolve(membership);
  }

  upsertSubscription(input: ChannelSubscriptionUpsert): Promise<ChannelSubscription> {
    const existing = this.subscriptions.get(subscriptionKey(input.channelId, input.subscriptionIdentity));
    const subscription: ChannelSubscription = {
      ...input,
      subscriptionId: existing?.subscriptionId ?? `subscription:${input.channelId}:${input.subscriptionIdentity}`,
      status: input.status ?? existing?.status ?? "active",
      lastSeenAt: existing?.lastSeenAt,
      lastClaimedAt: existing?.lastClaimedAt,
      updatedAt: new Date(),
    };
    this.subscriptions.set(subscriptionKey(input.channelId, input.subscriptionIdentity), subscription);
    return Promise.resolve(subscription);
  }

  releaseSubscription(input: ChannelSubscriptionRelease): Promise<void> {
    const key = subscriptionKey(input.channelId, input.subscriptionIdentity);
    const existing = this.subscriptions.get(key);
    if (existing !== undefined) {
      this.subscriptions.set(key, {
        ...existing,
        status: input.status ?? "offline",
        evidenceRefs: input.evidenceRefs ?? existing.evidenceRefs,
        updatedAt: new Date(),
      });
    }
    return Promise.resolve();
  }

  updateSubscriptionStatus(input: ChannelSubscriptionStatusUpdate): Promise<void> {
    const key = subscriptionKey(input.channelId, input.subscriptionIdentity);
    const existing = this.subscriptions.get(key);
    if (existing !== undefined) {
      this.subscriptions.set(key, {
        ...existing,
        status: input.status,
        lastSeenAt: input.lastSeenAt ?? existing.lastSeenAt,
        lastClaimedAt: input.lastClaimedAt ?? existing.lastClaimedAt,
        evidenceRefs: input.evidenceRefs ?? existing.evidenceRefs,
        updatedAt: new Date(),
      });
    }
    return Promise.resolve();
  }

  getPresence(input: ChannelPresenceQuery): Promise<readonly ChannelPresence[]> {
    const rows: ChannelPresence[] = [];
    for (const membership of this.memberships.values()) {
      if (membership.channelId !== input.channelId) continue;
      if (input.memberIdentity !== undefined && input.memberIdentity !== membership.memberIdentity) continue;
      const subscription = this.findSubscription(input, membership.memberIdentity);
      rows.push({
        channelId: membership.channelId,
        memberIdentity: membership.memberIdentity,
        memberType: membership.memberType,
        profileIdentity: membership.profileIdentity,
        memberRole: membership.memberRole,
        membershipStatus: membership.status,
        presenceState: toPresenceState(membership.status, subscription?.status),
        reachability: subscription?.status === "active" || subscription?.status === "busy" ? "reachable" : "unreachable",
        subscription,
        evidenceRefs: subscription?.evidenceRefs,
        lastSeenAt: subscription?.lastSeenAt,
        lastClaimedAt: subscription?.lastClaimedAt,
        lastActivityAt: subscription?.updatedAt ?? membership.updatedAt,
      });
    }
    return Promise.resolve(rows);
  }

  private findSubscription(
    query: ChannelPresenceQuery,
    memberIdentity: string,
  ): ChannelSubscription | undefined {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.channelId !== query.channelId) continue;
      if (subscription.memberIdentity !== memberIdentity) continue;
      if (query.subscriptionIdentity !== undefined
        && subscription.subscriptionIdentity !== query.subscriptionIdentity) continue;
      if (query.purpose !== undefined && subscription.purpose !== query.purpose) continue;
      return subscription;
    }
    return undefined;
  }
}

function membershipKey(channelId: string, memberIdentity: string): string {
  return `${channelId}:${memberIdentity}`;
}

function subscriptionKey(channelId: string, subscriptionIdentity: string): string {
  return `${channelId}:${subscriptionIdentity}`;
}

function toPresenceState(
  membershipStatus: ChannelMembership["status"],
  subscriptionStatus: ChannelSubscriptionStatus | undefined,
): ChannelPresenceState {
  if (membershipStatus === "left") return "left";
  if (membershipStatus !== "active") return "unknown";
  return subscriptionStatus ?? "offline";
}
