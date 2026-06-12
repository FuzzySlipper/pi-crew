import { describe, expect, it } from "vitest";
import { FakeChannelProvider, FakeLogger } from "@pi-crew/core";
import { projectDelegationMessageToChannel } from "../../workers/den-delegation-channel-projection.js";

describe("delegation channel projection text", () => {
  it("renders correlation and bounded work details in the visible channel body", async () => {
    const channel = new FakeChannelProvider();
    projectDelegationMessageToChannel({
      channelProvider: channel,
      channelId: "642",
      logger: new FakeLogger(),
      message: {
        eventName: "delegation.spawned",
        summary: "Subagent spawned: depth 1, profile conv-orchestrator-test",
        details: {
          childSessionId: "delegated-session-1",
          parentSessionId: "sess-conv-orchestrator-test",
          rootSessionId: "sess-conv-orchestrator-test",
          profileId: "conv-orchestrator-test",
          provider: "den-router",
          model: "gpt",
          policyId: "delegated-delegated-session-1",
          task: "Inspect #2296 and return a bounded DelegatedResult.",
        },
      },
    });
    await Promise.resolve();

    const text = channel.sentMessages[0]?.content.kind === "text"
      ? channel.sentMessages[0].content.text
      : "";
    expect(text).toContain("**delegation.spawned**");
    expect(text).toContain("Subagent spawned: depth 1, profile conv-orchestrator-test");
    expect(text).toContain("childSessionId: `delegated-session-1`");
    expect(text).toContain("parentSessionId: `sess-conv-orchestrator-test`");
    expect(text).toContain("profileId: `conv-orchestrator-test`");
    expect(text).toContain("task: Inspect #2296 and return a bounded DelegatedResult.");
  });
});
