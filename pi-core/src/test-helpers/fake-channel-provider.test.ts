import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeChannelProvider } from "./fake-channel-provider.js";
import type {
  ChannelProvider,
  ChannelMessage,
  ChannelParticipant,
  ChannelBreadcrumb,
  ChannelInfo,
} from "../channel.js";

function makeParticipant(
  overrides?: Partial<ChannelParticipant>,
): ChannelParticipant {
  return {
    id: "u1",
    displayName: "Alice",
    kind: "human",
    platform: "den-channels",
    ...overrides,
  };
}

function makeMessage(
  overrides?: Partial<ChannelMessage>,
): ChannelMessage {
  return {
    id: "m1",
    channelId: "ch1",
    sender: makeParticipant(),
    content: { kind: "text", text: "hello" },
    timestamp: new Date(),
    ...overrides,
  };
}

function makeBreadcrumb(
  overrides?: Partial<ChannelBreadcrumb>,
): ChannelBreadcrumb {
  return {
    id: "bc1",
    channelId: "ch1",
    category: "tool",
    status: "started",
    description: "running search",
    ...overrides,
  };
}

describe("FakeChannelProvider", () => {
  let provider: FakeChannelProvider;

  beforeEach(() => {
    provider = new FakeChannelProvider();
  });

  it("satisfies the ChannelProvider interface", () => {
    const p: ChannelProvider = provider;
    expect(p).toBe(provider);
  });

  // ── connection lifecycle ──────────────────────────────────

  it("starts disconnected", () => {
    expect(provider.isConnected).toBe(false);
  });

  it("connect sets isConnected to true", async () => {
    await provider.connect();
    expect(provider.isConnected).toBe(true);
  });

  it("disconnect sets isConnected to false", async () => {
    await provider.connect();
    expect(provider.isConnected).toBe(true);
    await provider.disconnect();
    expect(provider.isConnected).toBe(false);
  });

  it("connect is idempotent", async () => {
    await provider.connect();
    await provider.connect();
    expect(provider.isConnected).toBe(true);
  });

  // ── channel discovery ────────────────────────────────────

  it("listChannels returns empty initially", async () => {
    expect(await provider.listChannels()).toEqual([]);
  });

  it("channelExists returns false for unknown channel", async () => {
    expect(await provider.channelExists("ch1")).toBe(false);
  });

  it("channelExists returns true after addChannel", async () => {
    const ch: ChannelInfo = { id: "ch1", name: "general", kind: "channel" };
    provider.addChannel(ch);
    expect(await provider.channelExists("ch1")).toBe(true);
  });

  it("listChannels returns added channels", async () => {
    const ch1: ChannelInfo = {
      id: "ch1",
      name: "general",
      kind: "channel",
    };
    const ch2: ChannelInfo = { id: "ch2", name: "DMs", kind: "direct" };
    provider.addChannel(ch1);
    provider.addChannel(ch2);

    const channels = await provider.listChannels();
    expect(channels).toHaveLength(2);
    const c0 = channels[0];
    expect(c0).toBeDefined();
    if (c0) {
      expect(c0.id).toBe("ch1");
    }
    const c1 = channels[1];
    expect(c1).toBeDefined();
    if (c1) {
      expect(c1.id).toBe("ch2");
    }
  });

  // ── sendMessage ───────────────────────────────────────────

  it("sendMessage returns an ack with id and timestamp", async () => {
    const result = await provider.sendMessage("ch1", {
      kind: "text",
      text: "hi",
    });
    expect(result.id).toMatch(/^fake-msg-/);
    expect(result.channelId).toBe("ch1");
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it("sendMessage captures content and result", async () => {
    const result = await provider.sendMessage("ch2", {
      kind: "text",
      text: "hello ch2",
    });
    expect(provider.sentMessages).toHaveLength(1);
    const sent = provider.sentMessages[0];
    expect(sent).toBeDefined();
    if (sent) {
      expect(sent.channelId).toBe("ch2");
      expect(sent.content).toEqual({ kind: "text", text: "hello ch2" });
      expect(sent.result).toEqual(result);
    }
  });

  it("sendMessage increments message ids", async () => {
    const r1 = await provider.sendMessage("ch1", {
      kind: "text",
      text: "a",
    });
    const r2 = await provider.sendMessage("ch1", {
      kind: "text",
      text: "b",
    });
    expect(r1.id).not.toBe(r2.id);
  });

  it("captures media content", async () => {
    await provider.sendMessage("ch1", {
      kind: "media",
      url: "https://example.com/img.png",
      mimeType: "image/png",
    });
    const sent = provider.sentMessages[0];
    expect(sent).toBeDefined();
    if (sent && sent.content.kind === "media") {
      expect(sent.content.url).toBe("https://example.com/img.png");
      expect(sent.content.mimeType).toBe("image/png");
    }
  });

  // ── updateMessage / deleteMessage ─────────────────────────

  it("updateMessage captures the call", async () => {
    await provider.updateMessage("ch1", "msg-99", {
      kind: "text",
      text: "edited",
    });
    expect(provider.updatedMessages).toHaveLength(1);
    const u = provider.updatedMessages[0];
    expect(u).toBeDefined();
    if (u) {
      expect(u.channelId).toBe("ch1");
      expect(u.messageId).toBe("msg-99");
      expect(u.content).toEqual({ kind: "text", text: "edited" });
    }
  });

  it("deleteMessage captures the call", async () => {
    await provider.deleteMessage("ch1", "msg-77");
    expect(provider.deletedMessages).toHaveLength(1);
    const d = provider.deletedMessages[0];
    if (d) {
      expect(d.channelId).toBe("ch1");
      expect(d.messageId).toBe("msg-77");
    }
  });

  // ── breadcrumbs ───────────────────────────────────────────

  it("sendBreadcrumb captures the breadcrumb", async () => {
    const bc = makeBreadcrumb();
    await provider.sendBreadcrumb(bc);
    expect(provider.breadcrumbs).toHaveLength(1);
    expect(provider.breadcrumbs[0]).toEqual(bc);
  });

  it("captures multiple breadcrumbs in order", async () => {
    const bc1 = makeBreadcrumb({ id: "bc1", status: "started" });
    const bc2 = makeBreadcrumb({ id: "bc2", status: "in_progress" });
    await provider.sendBreadcrumb(bc1);
    await provider.sendBreadcrumb(bc2);
    expect(provider.breadcrumbs).toHaveLength(2);
    const b0 = provider.breadcrumbs[0];
    expect(b0).toBeDefined();
    if (b0) {
      expect(b0.id).toBe("bc1");
    }
    const b1 = provider.breadcrumbs[1];
    expect(b1).toBeDefined();
    if (b1) {
      expect(b1.id).toBe("bc2");
    }
  });

  it("updateBreadcrumb captures the update", async () => {
    await provider.updateBreadcrumb("bc1", {
      status: "completed",
      description: "done",
    });
    expect(provider.breadcrumbUpdates).toHaveLength(1);
    const u = provider.breadcrumbUpdates[0];
    expect(u).toBeDefined();
    if (u) {
      expect(u.breadcrumbId).toBe("bc1");
      expect(u.update.status).toBe("completed");
      expect(u.update.description).toBe("done");
    }
  });

  it("supports partial breadcrumb update (status only)", async () => {
    await provider.updateBreadcrumb("bc1", { status: "failed" });
    const u = provider.breadcrumbUpdates[0];
    if (u) {
      expect(u.update.status).toBe("failed");
      expect(u.update.description).toBeUndefined();
    }
  });

  // ── simulate inbound message ──────────────────────────────

  it("routes a simulated inbound message to the registered handler", async () => {
    const handler = vi.fn();
    provider.onMessage(handler);

    const msg = makeMessage({ id: "inbound-1", channelId: "ch1" });
    await provider.simulateInboundMessage(msg);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("does not throw when simulating with no registered handler", async () => {
    const msg = makeMessage();
    await expect(
      provider.simulateInboundMessage(msg),
    ).resolves.toBeUndefined();
  });

  it("handler can be replaced", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();

    provider.onMessage(h1);
    provider.onMessage(h2); // replaces h1

    const msg = makeMessage();
    await provider.simulateInboundMessage(msg);

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  // ── clear ─────────────────────────────────────────────────

  it("clear resets all captured state", async () => {
    provider.addChannel({ id: "ch1", name: "general", kind: "channel" });
    await provider.sendMessage("ch1", { kind: "text", text: "hi" });
    await provider.sendBreadcrumb(makeBreadcrumb());
    await provider.updateBreadcrumb("bc1", { status: "completed" });

    expect(provider.channels).not.toHaveLength(0);
    expect(provider.sentMessages).not.toHaveLength(0);
    expect(provider.breadcrumbs).not.toHaveLength(0);

    provider.clear();

    expect(provider.channels).toHaveLength(0);
    expect(provider.sentMessages).toHaveLength(0);
    expect(provider.updatedMessages).toHaveLength(0);
    expect(provider.deletedMessages).toHaveLength(0);
    expect(provider.breadcrumbs).toHaveLength(0);
    expect(provider.breadcrumbUpdates).toHaveLength(0);
  });

  // ── governance breadcrumb lifecycle ───────────────────────

  it("supports a full breadcrumb lifecycle: started → completed", async () => {
    await provider.sendBreadcrumb(
      makeBreadcrumb({
        id: "bc-run",
        category: "tool",
        status: "started",
        description: "searching",
      }),
    );

    await provider.updateBreadcrumb("bc-run", {
      status: "in_progress",
    });

    await provider.updateBreadcrumb("bc-run", {
      status: "completed",
      description: "search done",
    });

    expect(provider.breadcrumbs).toHaveLength(1);
    expect(provider.breadcrumbUpdates).toHaveLength(2);

    const u0 = provider.breadcrumbUpdates[0];
    if (u0) {
      expect(u0.update.status).toBe("in_progress");
    }
    const u1 = provider.breadcrumbUpdates[1];
    if (u1) {
      expect(u1.update.status).toBe("completed");
    }
  });
});
