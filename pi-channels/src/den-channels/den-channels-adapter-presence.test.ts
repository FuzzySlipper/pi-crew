import { describe, expect, it } from "vitest";
import {
  FakeLogger,
  isChannelMembershipProvider,
  isChannelPresenceProvider,
  type ChannelMembership,
  type ChannelMembershipUpsert,
  type ChannelPresence,
  type ChannelPresenceQuery,
  type ChannelSubscription,
  type ChannelSubscriptionRelease,
  type ChannelSubscriptionStatusUpdate,
  type ChannelSubscriptionUpsert,
} from "@pi-crew/core";
import { DenChannelsAdapter } from "./den-channels-adapter.js";
import { SimulatedDenConnection } from "./connection-simulated.js";

class PresenceConnection extends SimulatedDenConnection {
  readonly memberships: ChannelMembershipUpsert[] = [];
  readonly subscriptions: ChannelSubscriptionUpsert[] = [];
  readonly statusUpdates: ChannelSubscriptionStatusUpdate[] = [];
  readonly releases: ChannelSubscriptionRelease[] = [];

  upsertMembership(input: ChannelMembershipUpsert): Promise<ChannelMembership> {
    this.memberships.push(input);
    return Promise.resolve({ ...input, membershipId: "membership-1", status: input.status ?? "active", updatedAt: new Date() });
  }

  upsertSubscription(input: ChannelSubscriptionUpsert): Promise<ChannelSubscription> {
    this.subscriptions.push(input);
    return Promise.resolve({ ...input, subscriptionId: "subscription-1", status: input.status ?? "active", updatedAt: new Date() });
  }

  releaseSubscription(input: ChannelSubscriptionRelease): Promise<void> {
    this.releases.push(input);
    return Promise.resolve();
  }

  updateSubscriptionStatus(input: ChannelSubscriptionStatusUpdate): Promise<void> {
    this.statusUpdates.push(input);
    return Promise.resolve();
  }

  getPresence(input: ChannelPresenceQuery): Promise<readonly ChannelPresence[]> {
    void input;
    return Promise.resolve([]);
  }
}

describe("DenChannelsAdapter presence capabilities", () => {
  it("delegates membership and presence capability calls to the connection", async () => {
    const connection = new PresenceConnection(new FakeLogger());
    const adapter = new DenChannelsAdapter(connection, new FakeLogger());

    expect(isChannelMembershipProvider(adapter)).toBe(true);
    expect(isChannelPresenceProvider(adapter)).toBe(true);

    await adapter.upsertMembership({
      channelId: "642",
      memberIdentity: "pi-crew-runner",
      memberType: "agent",
      status: "active",
    });
    await adapter.upsertSubscription({
      channelId: "642",
      memberIdentity: "pi-crew-runner",
      subscriptionIdentity: "sub-1",
      purpose: "ordinary_channel",
      status: "active",
    });
    await adapter.updateSubscriptionStatus({
      channelId: "642",
      subscriptionIdentity: "sub-1",
      status: "idle",
    });
    await adapter.releaseSubscription({
      channelId: "642",
      subscriptionIdentity: "sub-1",
      status: "offline",
    });

    expect(connection.memberships).toHaveLength(1);
    expect(connection.subscriptions).toHaveLength(1);
    expect(connection.statusUpdates).toHaveLength(1);
    expect(connection.releases).toHaveLength(1);
  });
});
