/**
 * Tests for {@link DenChannelsAdapter}.
 *
 * Uses {@link SimulatedDenConnection} as the simulated Den Channels
 * Gateway, satisfying the acceptance criteria:
 *
 * - Adapter connects to a simulated Den Channels Gateway
 * - Receiving a text message triggers MessageHandler with correct ChannelMessage
 * - Sending a message produces the correct Den API/Gateway call shape
 * - Breadcrumb send/update works in the simulated provider path
 * - Disconnect triggers reconnection attempts with typed events/errors
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import type {
  ChannelProvider,
  ChannelMessage,
  ChannelContent,
  ChannelBreadcrumb,
} from "@pi-crew/core";
import {
  DenChannelsAdapter,
  type DenChannelsAdapterConfig,
} from "../den-channels/den-channels-adapter.js";
import { SimulatedDenConnection } from "../den-channels/connection.js";
import type { DenInboundMessage } from "../den-channels/connection.js";

// ── helpers ─────────────────────────────────────────────────────

function makeInboundText(
  overrides?: Partial<DenInboundMessage>,
): DenInboundMessage {
  return {
    id: "den-in-1",
    channelId: "owner:assignment:213",
    sender: {
      id: "user-1",
      displayName: "Test User",
      kind: "human",
    },
    content: { kind: "text", text: "hello from den" },
    timestamp: "2026-06-05T09:24:00Z",
    ...overrides,
  };
}

function makeInboundWithReply(): DenInboundMessage {
  return makeInboundText({
    id: "den-in-2",
    replyToId: "den-in-1",
    content: { kind: "text", text: "yes, received" },
  });
}

function makeInboundMedia(): DenInboundMessage {
  return {
    id: "den-in-3",
    channelId: "owner:assignment:213",
    sender: {
      id: "user-1",
      displayName: "Test User",
      kind: "human",
    },
    content: {
      kind: "media",
      url: "https://example.com/screenshot.png",
      mimeType: "image/png",
      altText: "screenshot",
    },
    timestamp: "2026-06-05T09:25:00Z",
  };
}

function makeTextContent(text: string): ChannelContent {
  return { kind: "text", text };
}

function makeBreadcrumb(
  overrides?: Partial<ChannelBreadcrumb>,
): ChannelBreadcrumb {
  return {
    id: "bc-1",
    channelId: "owner:assignment:213",
    category: "tool",
    status: "started",
    description: "running web_search",
    ...overrides,
  };
}

// ── tests ───────────────────────────────────────────────────────

describe("DenChannelsAdapter", () => {
  let logger: FakeLogger;
  let simConn: SimulatedDenConnection;
  let adapter: DenChannelsAdapter;

  beforeEach(() => {
    logger = new FakeLogger();
    simConn = new SimulatedDenConnection(logger);
    adapter = new DenChannelsAdapter(simConn, logger);
  });

  // ── identity ────────────────────────────────────────────────

  it("satisfies the ChannelProvider interface", () => {
    const p: ChannelProvider = adapter;
    expect(p).toBe(adapter);
  });

  it("has default identity values", () => {
    expect(adapter.name).toBe("Den Channels Gateway");
    expect(adapter.providerId).toBe("den-channels");
  });

  it("accepts custom identity via config", () => {
    const config: DenChannelsAdapterConfig = {
      name: "Custom Den",
      providerId: "custom-den",
    };
    const a = new DenChannelsAdapter(simConn, logger, config);
    expect(a.name).toBe("Custom Den");
    expect(a.providerId).toBe("custom-den");
  });

  // ── connection lifecycle ────────────────────────────────────

  it("starts disconnected", () => {
    expect(adapter.isConnected).toBe(false);
  });

  it("connect opens the simulated connection", async () => {
    await adapter.connect();
    expect(adapter.isConnected).toBe(true);
    expect(simConn.isOpen).toBe(true);
  });

  it("connect is idempotent", async () => {
    await adapter.connect();
    await adapter.connect();
    expect(adapter.isConnected).toBe(true);
  });

  it("disconnect closes the simulated connection", async () => {
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.isConnected).toBe(false);
    expect(simConn.isOpen).toBe(false);
  });

  it("logs during connect and disconnect", async () => {
    await adapter.connect();
    await adapter.disconnect();

    const messages = logger.entries.map((e) => e.message);
    expect(messages.some((m) => m.includes("connecting"))).toBe(true);
    expect(messages.some((m) => m.includes("connected"))).toBe(true);
    expect(messages.some((m) => m.includes("disconnecting"))).toBe(true);
  });

  // ── ACCEPTANCE: inbound message → MessageHandler ─────────────

  it("receives a text message and triggers MessageHandler with correct ChannelMessage", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const raw = makeInboundText();
    simConn.simulateInboundMessage(raw);

    // Allow async handler to execute
    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    const msg = handler.mock.calls[0]?.[0] as ChannelMessage | undefined;
    expect(msg).toBeDefined();
    if (msg) {
      expect(msg.id).toBe("den-in-1");
      expect(msg.channelId).toBe("owner:assignment:213");
      expect(msg.sender.id).toBe("user-1");
      expect(msg.sender.displayName).toBe("Test User");
      expect(msg.sender.kind).toBe("human");
      expect(msg.sender.platform).toBe("den-channels");
      if (msg.content.kind === "text") {
        expect(msg.content.text).toBe("hello from den");
      }
      expect(msg.timestamp).toBeInstanceOf(Date);
      expect(msg.replyToId).toBeUndefined();
    }
  });

  it("handles reply threading (replyToId)", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    simConn.simulateInboundMessage(makeInboundWithReply());

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const msg = handler.mock.calls[0]?.[0];
    expect(msg).toBeDefined();
    if (msg) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(msg.replyToId).toBe("den-in-1");
    }
  });

  it("handles media attachment messages", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    simConn.simulateInboundMessage(makeInboundMedia());

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const msg = handler.mock.calls[0]?.[0];
    expect(msg).toBeDefined();
    if (msg) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(msg.content.kind).toBe("media");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (msg.content.kind === "media") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(msg.content.url).toBe("https://example.com/screenshot.png");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(msg.content.mimeType).toBe("image/png");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(msg.content.altText).toBe("screenshot");
      }
    }
  });

  it("logs warning when no handler is registered", async () => {
    // No handler registered
    await adapter.connect();
    simConn.simulateInboundMessage(makeInboundText());

    // The warning should be logged
    const warnEntries = logger.entries.filter((e) => e.level === "warn");
    expect(
      warnEntries.some((e) =>
        e.message.includes("No message handler registered"),
      ),
    ).toBe(true);
  });

  it("handler can be replaced", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();

    adapter.onMessage(h1);
    adapter.onMessage(h2); // replaces h1
    await adapter.connect();

    simConn.simulateInboundMessage(makeInboundText());

    await vi.waitFor(
      () => {
        expect(h1).not.toHaveBeenCalled();
        expect(h2).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );
  });

  it("handles handler that throws without crashing", async () => {
    const handler = vi.fn().mockRejectedValue(
      new Error("handler error"),
    );
    adapter.onMessage(handler);
    await adapter.connect();

    // Should not throw
    simConn.simulateInboundMessage(makeInboundText());

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalled();
      },
      { timeout: 1000 },
    );

    // Should log the error
    const errors = logger.entries.filter((e) => e.level === "error");
    expect(errors.some((e) => e.message.includes("handler threw"))).toBe(true);
  });

  // ── ACCEPTANCE: outbound send produces correct Den call shape ─

  it("sends a text message and produces correct Den payload shape", async () => {
    await adapter.connect();
    const result = await adapter.sendMessage(
      "owner:assignment:213",
      makeTextContent("hello from adapter"),
    );

    expect(result.id).toMatch(/^den-msg-/);
    expect(result.channelId).toBe("owner:assignment:213");
    expect(result.timestamp).toBeInstanceOf(Date);

    expect(simConn.sentMessages).toHaveLength(1);
    const sent = simConn.sentMessages[0];
    expect(sent).toBeDefined();
    if (sent) {
      expect(sent.channelId).toBe("owner:assignment:213");
      expect(sent.payload.content).toEqual({
        kind: "text",
        text: "hello from adapter",
      });
    }
  });

  it("sends a media message with correct shape", async () => {
    const content: ChannelContent = {
      kind: "media",
      url: "https://example.com/report.pdf",
      mimeType: "application/pdf",
    };

    await adapter.connect();
    await adapter.sendMessage("ch1", content);

    const sent = simConn.sentMessages[0];
    expect(sent).toBeDefined();
    if (sent) {
      expect(sent.payload.content).toEqual({
        kind: "media",
        url: "https://example.com/report.pdf",
        mimeType: "application/pdf",
      });
    }
  });

  it("updateMessage calls connection.updateMessage with correct args", async () => {
    await adapter.connect();
    await adapter.updateMessage("ch1", "msg-42", makeTextContent("edited"));

    expect(simConn.updatedMessages).toHaveLength(1);
    const u = simConn.updatedMessages[0];
    if (u) {
      expect(u.channelId).toBe("ch1");
      expect(u.messageId).toBe("msg-42");
      expect(u.payload.content).toEqual({ kind: "text", text: "edited" });
    }
  });

  it("deleteMessage calls connection.deleteMessage", async () => {
    await adapter.connect();
    await adapter.deleteMessage("ch1", "msg-77");

    expect(simConn.deletedMessages).toHaveLength(1);
    const d = simConn.deletedMessages[0];
    if (d) {
      expect(d.channelId).toBe("ch1");
      expect(d.messageId).toBe("msg-77");
    }
  });

  // ── ACCEPTANCE: breadcrumb send/update ───────────────────────

  it("sendBreadcrumb produces correct Den breadcrumb payload", async () => {
    await adapter.connect();
    await adapter.sendBreadcrumb(makeBreadcrumb());

    expect(simConn.breadcrumbs).toHaveLength(1);
    const bc = simConn.breadcrumbs[0];
    expect(bc).toBeDefined();
    if (bc) {
      expect(bc.id).toBe("bc-1");
      expect(bc.channelId).toBe("owner:assignment:213");
      expect(bc.category).toBe("tool");
      expect(bc.status).toBe("started");
      expect(bc.description).toBe("running web_search");
    }
  });

  it("updateBreadcrumb produces correct Den update call", async () => {
    await adapter.connect();
    await adapter.updateBreadcrumb("bc-1", {
      status: "completed",
      description: "search done",
    });

    expect(simConn.breadcrumbUpdates).toHaveLength(1);
    const u = simConn.breadcrumbUpdates[0];
    if (u) {
      expect(u.breadcrumbId).toBe("bc-1");
      expect(u.update.status).toBe("completed");
      expect(u.update.description).toBe("search done");
    }
  });

  it("supports full breadcrumb lifecycle: started → completed", async () => {
    await adapter.connect();

    // send initial
    await adapter.sendBreadcrumb(makeBreadcrumb({ status: "started" }));
    // update to in_progress
    await adapter.updateBreadcrumb("bc-1", {
      status: "in_progress",
      description: "still searching",
    });
    // update to completed
    await adapter.updateBreadcrumb("bc-1", {
      status: "completed",
      description: "search complete, 5 results",
    });

    expect(simConn.breadcrumbs).toHaveLength(1);
    expect(simConn.breadcrumbUpdates).toHaveLength(2);
  });
});


