/**
 * Tests for the Den message format translation layer.
 *
 * Exercises every translation direction:
 * - Den inbound → ChannelMessage
 * - ChannelContent → Den outbound payload
 * - ChannelBreadcrumb → Den breadcrumb payload
 */

import { describe, it, expect } from "vitest";
import type { ChannelBreadcrumb } from "@pi-crew/core";
import type {
  DenInboundMessage,
  DenContent,
} from "../den-channels/connection.js";
import {
  translateInboundMessage,
  translateDenSender,
  translateDenContent,
  translateOutboundContent,
  channelContentToDenContent,
  translateBreadcrumbToDen,
} from "../den-channels/message-format.js";

// ── inbound translation ────────────────────────────────────────

describe("translateInboundMessage", () => {
  it("translates a text message", () => {
    const raw: DenInboundMessage = {
      id: "den-123",
      channelId: "owner:assignment:213",
      sender: {
        id: "user-1",
        displayName: "Alice",
        kind: "human",
      },
      content: { kind: "text", text: "hello world" },
      timestamp: "2026-06-05T09:24:00Z",
    };

    const msg = translateInboundMessage(raw);

    expect(msg.id).toBe("den-123");
    expect(msg.channelId).toBe("owner:assignment:213");
    expect(msg.sender.id).toBe("user-1");
    expect(msg.sender.displayName).toBe("Alice");
    expect(msg.sender.kind).toBe("human");
    expect(msg.sender.platform).toBe("den-channels");
    expect(msg.content.kind).toBe("text");
    if (msg.content.kind === "text") {
      expect(msg.content.text).toBe("hello world");
    }
    expect(msg.timestamp).toBeInstanceOf(Date);
    expect(msg.timestamp.toISOString()).toBe("2026-06-05T09:24:00.000Z");
    expect(msg.replyToId).toBeUndefined();
  });

  it("preserves replyToId", () => {
    const raw: DenInboundMessage = {
      id: "den-456",
      channelId: "ch1",
      sender: { id: "u2", displayName: "Bob", kind: "agent" },
      content: { kind: "text", text: "ack" },
      timestamp: "2026-06-05T10:00:00Z",
      replyToId: "den-123",
    };

    const msg = translateInboundMessage(raw);
    expect(msg.replyToId).toBe("den-123");
  });

  it("preserves metadata", () => {
    const raw: DenInboundMessage = {
      id: "den-789",
      channelId: "ch1",
      sender: { id: "sys", displayName: "System", kind: "system" },
      content: { kind: "text", text: "info" },
      timestamp: "2026-06-05T10:00:00Z",
      metadata: { priority: "high", ttl: 3600 },
    };

    const msg = translateInboundMessage(raw);
    expect(msg.metadata).toEqual({ priority: "high", ttl: 3600 });
  });

  it("translates media content", () => {
    const raw: DenInboundMessage = {
      id: "den-media",
      channelId: "ch1",
      sender: { id: "u1", displayName: "Alice", kind: "human" },
      content: {
        kind: "media",
        url: "https://example.com/img.png",
        mimeType: "image/png",
        altText: "screenshot",
      },
      timestamp: "2026-06-05T10:00:00Z",
    };

    const msg = translateInboundMessage(raw);
    expect(msg.content.kind).toBe("media");
    if (msg.content.kind === "media") {
      expect(msg.content.url).toBe("https://example.com/img.png");
      expect(msg.content.mimeType).toBe("image/png");
      expect(msg.content.altText).toBe("screenshot");
    }
  });

  it("translates mixed content", () => {
    const raw: DenInboundMessage = {
      id: "den-mixed",
      channelId: "ch1",
      sender: { id: "u1", displayName: "Alice", kind: "human" },
      content: {
        kind: "mixed",
        parts: [
          { kind: "text", text: "Check this" },
          {
            kind: "media",
            url: "https://example.com/img.png",
            mimeType: "image/png",
          },
        ],
      },
      timestamp: "2026-06-05T10:00:00Z",
    };

    const msg = translateInboundMessage(raw);
    expect(msg.content.kind).toBe("mixed");
    if (msg.content.kind === "mixed") {
      expect(msg.content.parts).toHaveLength(2);
      const p0 = msg.content.parts[0];
      expect(p0).toBeDefined();
      if (p0 && p0.kind === "text") {
        expect(p0.text).toBe("Check this");
      }
    }
  });
});

// ── sender translation ─────────────────────────────────────────

describe("translateDenSender", () => {
  it("maps kind correctly for human", () => {
    const sender = translateDenSender({
      id: "u1",
      displayName: "Alice",
      kind: "human",
    });
    expect(sender.kind).toBe("human");
    expect(sender.platform).toBe("den-channels");
  });

  it("maps agent and system kinds", () => {
    const agent = translateDenSender({
      id: "pi",
      displayName: "pi-crew-worker",
      kind: "agent",
    });
    expect(agent.kind).toBe("agent");

    const sys = translateDenSender({
      id: "sys",
      displayName: "System",
      kind: "system",
    });
    expect(sys.kind).toBe("system");
  });
});

// ── content translation ────────────────────────────────────────

describe("translateDenContent", () => {
  it("translates text", () => {
    const content: DenContent = { kind: "text", text: "hello" };
    const result = translateDenContent(content);
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe("hello");
    }
  });

  it("translates media", () => {
    const content: DenContent = {
      kind: "media",
      url: "https://example.com/file.pdf",
      mimeType: "application/pdf",
    };
    const result = translateDenContent(content);
    expect(result.kind).toBe("media");
    if (result.kind === "media") {
      expect(result.url).toBe("https://example.com/file.pdf");
      expect(result.mimeType).toBe("application/pdf");
    }
  });

  it("translates mixed (nested)", () => {
    const content: DenContent = {
      kind: "mixed",
      parts: [
        { kind: "text", text: "a" },
        { kind: "text", text: "b" },
      ],
    };
    const result = translateDenContent(content);
    expect(result.kind).toBe("mixed");
    if (result.kind === "mixed") {
      expect(result.parts).toHaveLength(2);
    }
  });
});

// ── outbound content translation ───────────────────────────────

describe("channelContentToDenContent", () => {
  it("translates text", () => {
    const result = channelContentToDenContent({
      kind: "text",
      text: "hello",
    });
    expect(result).toEqual({ kind: "text", text: "hello" });
  });

  it("translates media", () => {
    const result = channelContentToDenContent({
      kind: "media",
      url: "https://example.com/img.png",
      mimeType: "image/png",
      altText: "an image",
    });
    expect(result).toEqual({
      kind: "media",
      url: "https://example.com/img.png",
      mimeType: "image/png",
      altText: "an image",
    });
  });

  it("translates mixed with nested parts", () => {
    const result = channelContentToDenContent({
      kind: "mixed",
      parts: [
        { kind: "text", text: "part 1" },
        { kind: "text", text: "part 2" },
      ],
    });
    expect(result.kind).toBe("mixed");
    if (result.kind === "mixed") {
      expect(result.parts).toHaveLength(2);
    }
  });
});

describe("translateOutboundContent", () => {
  it("wraps content in den payload", () => {
    const payload = translateOutboundContent({
      kind: "text",
      text: "world",
    });
    expect(payload.content).toEqual({ kind: "text", text: "world" });
    expect(payload.replyToId).toBeUndefined();
    expect(payload.metadata).toBeUndefined();
  });

  it("includes replyToId when provided", () => {
    const payload = translateOutboundContent(
      { kind: "text", text: "reply" },
      { replyToId: "parent-1" },
    );
    expect(payload.replyToId).toBe("parent-1");
  });

  it("includes metadata when provided", () => {
    const payload = translateOutboundContent(
      { kind: "text", text: "with meta" },
      { metadata: { priority: "low" } },
    );
    expect(payload.metadata).toEqual({ priority: "low" });
  });

  it("includes both replyToId and metadata", () => {
    const payload = translateOutboundContent(
      { kind: "text", text: "both" },
      { replyToId: "r1", metadata: { key: "val" } },
    );
    expect(payload.replyToId).toBe("r1");
    expect(payload.metadata).toEqual({ key: "val" });
  });
});

// ── breadcrumb translation ─────────────────────────────────────

describe("translateBreadcrumbToDen", () => {
  it("translates a breadcrumb to Den payload", () => {
    const breadcrumb: ChannelBreadcrumb = {
      id: "bc-1",
      channelId: "ch1",
      category: "tool",
      status: "started",
      description: "running search",
      metadata: { toolName: "web_search" },
    };

    const den = translateBreadcrumbToDen(breadcrumb);
    expect(den.id).toBe("bc-1");
    expect(den.channelId).toBe("ch1");
    expect(den.category).toBe("tool");
    expect(den.status).toBe("started");
    expect(den.description).toBe("running search");
    expect(den.metadata).toEqual({ toolName: "web_search" });
  });

  it("handles breadcrumbs without metadata", () => {
    const breadcrumb: ChannelBreadcrumb = {
      id: "bc-2",
      channelId: "ch2",
      category: "decision",
      status: "completed",
      description: "approved",
    };

    const den = translateBreadcrumbToDen(breadcrumb);
    expect(den.id).toBe("bc-2");
    expect(den.metadata).toBeUndefined();
  });

  it("round-trips all status values", () => {
    const statuses: Array<ChannelBreadcrumb["status"]> = [
      "started",
      "in_progress",
      "completed",
      "failed",
    ];
    for (const status of statuses) {
      const breadcrumb: ChannelBreadcrumb = {
        id: `bc-${status}`,
        channelId: "ch1",
        category: "tool",
        status,
        description: `status=${status}`,
      };
      const den = translateBreadcrumbToDen(breadcrumb);
      expect(den.status).toBe(status);
    }
  });
});
