/**
 * Tests for ChannelRouter.
 *
 * Covers:
 * - Binding map construction
 * - Channel authorization (authorized channel passes, unauthorized drops)
 * - Mention matching (wraps existing routeMentionedAgent behavior)
 * - Cross-provider usage (Telegram, Den Channels)
 * - Logging on unauthorized messages
 */

import { describe, expect, it } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { ChannelRouter, type ChannelRouterAgentBinding } from "../channel-router.js";
import type { ChannelMessage } from "@pi-crew/core";

// ── Fixtures ─────────────────────────────────────────────────────

const AGENT_BINDINGS: readonly ChannelRouterAgentBinding[] = [
  {
    memberIdentity: "pi-crew-planner",
    channelIds: ["channel-1", "channel-2"],
  },
  {
    memberIdentity: "pi-crew-runner",
    channelIds: ["channel-2"],
  },
  {
    memberIdentity: "pi-crew-prime",
    channelIds: ["channel-3"],
  },
];

function makeTextMessage(
  overrides?: Partial<ChannelMessage>,
): ChannelMessage {
  return {
    id: "msg-1",
    channelId: "channel-1",
    sender: { id: "user-1", displayName: "User", kind: "human", platform: "test" },
    content: { kind: "text", text: "hello world" },
    timestamp: new Date(),
    metadata: {},
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("ChannelRouter", () => {
  describe("binding map", () => {
    it("accepts empty bindings", () => {
      const router = new ChannelRouter({ agentBindings: [] }, new FakeLogger());
      expect(router.hasChannel("anything")).toBe(false);
    });

    it("tracks channel-to-agent mappings", () => {
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, new FakeLogger());
      expect(router.hasChannel("channel-1")).toBe(true);
      expect(router.hasChannel("channel-2")).toBe(true);
      expect(router.hasChannel("channel-3")).toBe(true);
      expect(router.hasChannel("channel-unknown")).toBe(false);
    });

    it("returns agents for a channel", () => {
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, new FakeLogger());
      expect(router.agentsForChannel("channel-1")).toEqual(["pi-crew-planner"]);
      expect(router.agentsForChannel("channel-2")).toEqual(["pi-crew-planner", "pi-crew-runner"]);
      expect(router.agentsForChannel("unknown")).toEqual([]);
    });
  });

  describe("channel authorization", () => {
    it("passes messages from authorized channels", () => {
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, new FakeLogger());
      const msg = makeTextMessage({ channelId: "channel-1" });
      const result = router.route("den-channels", msg);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("msg-1");
    });

    it("drops messages from unauthorized channels", () => {
      const logger = new FakeLogger();
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, logger);
      const msg = makeTextMessage({ channelId: "channel-unauthorized" });
      const result = router.route("den-channels", msg);
      expect(result).toBeNull();
    });

    it("drops messages from channels with no agents bound", () => {
      const logger = new FakeLogger();
      const router = new ChannelRouter({ agentBindings: [] }, logger);
      const msg = makeTextMessage({ channelId: "channel-1" });
      const result = router.route("den-channels", msg);
      expect(result).toBeNull();
    });

    it("includes provider name in log when dropping", () => {
      const logger = new FakeLogger();
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, logger);
      const msg = makeTextMessage({ channelId: "unrecognised" });
      router.route("telegram", msg);
      expect(
        logger.entries.some(
          (e) => e.message.includes("unauthorized channel") && e.context?.provider === "telegram",
        ),
      ).toBe(true);
    });
  });

  describe("mention matching", () => {
    it("rewrites metadata when message @mentions a bound agent", () => {
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, new FakeLogger());
      const msg = makeTextMessage({
        channelId: "channel-2",
        content: { kind: "text", text: "@pi-crew-planner please review" },
      });
      const result = router.route("den-channels", msg);
      expect(result).not.toBeNull();
      expect(result!.metadata?.memberIdentity).toBe("pi-crew-planner");
    });

    it("passes through unchanged when no @mention matches", () => {
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, new FakeLogger());
      const msg = makeTextMessage({
        channelId: "channel-1",
        content: { kind: "text", text: "just a regular message" },
      });
      const result = router.route("den-channels", msg);
      expect(result).not.toBeNull();
      expect(result!.metadata?.memberIdentity).toBeUndefined();
    });

    it("passes through media messages without mention rewriting", () => {
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, new FakeLogger());
      const msg: ChannelMessage = {
        id: "msg-2",
        channelId: "channel-1",
        sender: { id: "user-1", displayName: "User", kind: "human", platform: "test" },
        content: { kind: "media", url: "https://example.com/img.png", mimeType: "image/png" },
        timestamp: new Date(),
        metadata: {},
      };
      const result = router.route("den-channels", msg);
      expect(result).not.toBeNull();
      expect(result!.metadata?.memberIdentity).toBeUndefined();
    });
  });

  describe("cross-provider support", () => {
    it("works with Telegram provider", () => {
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, new FakeLogger());
      const msg = makeTextMessage({
        channelId: "channel-3",
        content: { kind: "text", text: "@pi-crew-prime status report" },
      });
      const result = router.route("telegram", msg);
      expect(result).not.toBeNull();
      expect(result!.metadata?.memberIdentity).toBe("pi-crew-prime");
    });

    it("drops unauthorized messages from any provider", () => {
      const logger = new FakeLogger();
      const router = new ChannelRouter({ agentBindings: AGENT_BINDINGS }, logger);
      const msg = makeTextMessage({
        channelId: "spam-channel",
        content: { kind: "text", text: "spam" },
      });
      const result = router.route("telegram", msg);
      expect(result).toBeNull();
    });
  });
});
