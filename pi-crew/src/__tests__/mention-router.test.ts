/**
 * Tests for the mention-aware pre-routing module.
 *
 * @module pi-crew/__tests__/mention-router.test
 */

import { describe, it, expect } from "vitest";
import type { ChannelMessage } from "@pi-crew/core";
import {
  routeMentionedAgent,
  type MentionRouterAgent,
} from "../mention-router.js";

// ── Helpers ─────────────────────────────────────────────────────

const AGENTS: readonly MentionRouterAgent[] = [
  { memberIdentity: "prime-coder" },
  { memberIdentity: "pi-orchestrator" },
  { memberIdentity: "pi-crew-runner-clone" },
  { memberIdentity: "agora-prime" },
  { memberIdentity: "service-caretaker" },
];

function textMessage(text: string, metadata?: Record<string, unknown>): ChannelMessage {
  return {
    id: "msg-1",
    channelId: "642",
    sender: { id: "human-1", displayName: "Alice", kind: "human", platform: "den-channels" },
    content: { kind: "text", text },
    timestamp: new Date("2026-06-18T12:00:00Z"),
    metadata,
  };
}

function mediaMessage(): ChannelMessage {
  return {
    id: "msg-2",
    channelId: "642",
    sender: { id: "human-1", displayName: "Alice", kind: "human", platform: "den-channels" },
    content: { kind: "media", url: "https://example.com/image.png", mimeType: "image/png" },
    timestamp: new Date("2026-06-18T12:00:00Z"),
  };
}

function mixedMessage(parts: Array<ChannelMessage["content"]>): ChannelMessage {
  return {
    id: "msg-3",
    channelId: "642",
    sender: { id: "human-1", displayName: "Alice", kind: "human", platform: "den-channels" },
    content: { kind: "mixed", parts: parts as never[] },
    timestamp: new Date("2026-06-18T12:00:00Z"),
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("routeMentionedAgent", () => {
  it("routes @mention of a configured full agent", () => {
    const msg = textMessage("@prime-coder please review this PR");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result).not.toBe(msg); // new object
    expect(result.metadata?.memberIdentity).toBe("prime-coder");
  });

  it("routes @mention at start of message", () => {
    const msg = textMessage("@pi-orchestrator what do you think?");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result.metadata?.memberIdentity).toBe("pi-orchestrator");
  });

  it("routes @mention with hyphenated agent identity", () => {
    const msg = textMessage("Hey @pi-crew-runner-clone, status?");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result.metadata?.memberIdentity).toBe("pi-crew-runner-clone");
  });

  it("routes @mention inside parentheses or after punctuation", () => {
    const msg = textMessage("Let's ask (@agora-prime) about this.");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result.metadata?.memberIdentity).toBe("agora-prime");
  });

  it("uses the FIRST matching @mention when multiple are present", () => {
    const msg = textMessage("@prime-coder and @pi-orchestrator both review");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result.metadata?.memberIdentity).toBe("prime-coder");
  });

  it("ignores @mention of a non-configured identity", () => {
    const msg = textMessage("@bob please help");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result).toBe(msg); // unchanged identity
    expect(result.metadata?.memberIdentity).toBeUndefined();
  });

  it("returns unchanged message when no @mention present", () => {
    const msg = textMessage("Hello everyone");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result).toBe(msg); // same reference
  });

  it("returns unchanged message when text has no @ symbol at all", () => {
    const msg = textMessage("Just a regular message.");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result).toBe(msg);
  });

  it("skips media messages (no text to parse)", () => {
    const msg = mediaMessage();
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result).toBe(msg);
  });

  it("skips mixed messages (no text to parse at top level)", () => {
    const msg = mixedMessage([]);
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result).toBe(msg);
  });

  it("returns unchanged when agents list is empty", () => {
    const msg = textMessage("@prime-coder help");
    const result = routeMentionedAgent(msg, []);
    expect(result).toBe(msg);
  });

  it("overrides existing memberIdentity metadata with @mention", () => {
    const msg = textMessage("@prime-coder review this", {
      memberIdentity: "some-other-agent",
    });
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result.metadata?.memberIdentity).toBe("prime-coder");
  });

  it("preserves existing non-memberIdentity metadata when rewriting", () => {
    const msg = textMessage("@prime-coder review this", {
      sourceProjectId: "pi-crew",
      eventKind: "direct-agent-event",
    });
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result.metadata?.memberIdentity).toBe("prime-coder");
    expect(result.metadata?.sourceProjectId).toBe("pi-crew");
    expect(result.metadata?.eventKind).toBe("direct-agent-event");
  });

  it("does not match @ in email addresses (not preceded by word boundary)", () => {
    const msg = textMessage("Contact me at user@example.com for @prime-coder");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result.metadata?.memberIdentity).toBe("prime-coder");
  });

  it("does not match @mid-word (not preceded by whitespace/punctuation)", () => {
    const msg = textMessage("not an @mention but @prime-coder is");
    const result = routeMentionedAgent(msg, AGENTS);
    expect(result.metadata?.memberIdentity).toBe("prime-coder");
  });
});
