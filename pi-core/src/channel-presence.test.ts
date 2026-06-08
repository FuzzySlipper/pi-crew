import { describe, expect, it } from "vitest";
import type { ChannelProvider } from "./channel.js";
import {
  isChannelMembershipProvider,
  isChannelPresenceProvider,
  type ChannelMembershipProvider,
  type ChannelPresenceProvider,
} from "./channel-presence.js";
import { FakeChannelProvider } from "./test-helpers/fake-channel-provider.js";
import { FakeMembershipChannelProvider } from "./test-helpers/fake-membership-channel-provider.js";

describe("channel membership/presence contracts", () => {
  it("keeps unsupported adapters valid as base ChannelProvider implementations", () => {
    const provider: ChannelProvider = new FakeChannelProvider();

    expect(isChannelMembershipProvider(provider)).toBe(false);
    expect(isChannelPresenceProvider(provider)).toBe(false);
  });

  it("detects providers that opt into membership and presence capabilities", () => {
    const provider = new FakeMembershipChannelProvider();
    const membershipProvider: ChannelMembershipProvider = provider;
    const presenceProvider: ChannelPresenceProvider = provider;

    expect(isChannelMembershipProvider(membershipProvider)).toBe(true);
    expect(isChannelPresenceProvider(presenceProvider)).toBe(true);
  });

  it("models stable membership separately from runtime subscription", async () => {
    const provider = new FakeMembershipChannelProvider();
    const membership = await provider.upsertMembership({
      channelId: "604",
      memberIdentity: "pi-crew-runner",
      memberType: "agent",
      profileIdentity: "pi-crew-runner",
      memberRole: "runner",
      wakePolicy: "subscription",
    });
    const subscription = await provider.upsertSubscription({
      channelId: "604",
      memberIdentity: "pi-crew-runner",
      profileIdentity: "pi-crew-runner",
      subscriptionIdentity: "den-k8:runner:ordinary",
      purpose: "ordinary_channel",
      agentInstanceId: "agent-instance-1",
      sessionOwnerId: "owner:den-k8plus",
      sessionId: "session-1",
      status: "active",
    });

    expect(membership.memberIdentity).toBe(subscription.memberIdentity);
    expect(membership.membershipId).not.toBe(subscription.subscriptionId);
    expect(subscription.agentInstanceId).toBe("agent-instance-1");
  });

  it("captures Den-facing work and evidence references without pi substrate names", async () => {
    const provider = new FakeMembershipChannelProvider();
    await provider.upsertMembership({
      channelId: "604",
      memberIdentity: "pool-reviewer-02",
      memberType: "agent",
      profileIdentity: "spawned-reviewer",
      memberRole: "reviewer",
    });
    await provider.upsertSubscription({
      channelId: "604",
      memberIdentity: "pool-reviewer-02",
      subscriptionIdentity: "pool-reviewer-02:worker_pool_control",
      purpose: "worker_pool_control",
      status: "busy",
      agentInstanceId: "hermes:den-k8:spawned-reviewer:pool-reviewer-02:live",
      workRefs: { projectId: "pi-crew", taskId: "2111", assignmentId: "852", runId: "piw-1" },
      evidenceRefs: { directAgentEventId: "3996" },
    });

    const rows = await provider.getPresence({ channelId: "604", memberIdentity: "pool-reviewer-02" });
    const presence = rows[0];

    expect(presence).toBeDefined();
    expect(presence?.presenceState).toBe("busy");
    expect(presence?.reachability).toBe("reachable");
    expect(presence?.subscription?.workRefs?.assignmentId).toBe("852");
    expect(presence?.evidenceRefs?.directAgentEventId).toBe("3996");
  });
});
