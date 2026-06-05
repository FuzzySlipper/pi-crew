import { describe, it, expect } from "vitest";
import type {
  ChannelProvider,
  ChannelParticipant,
  ChannelContent,
  ChannelBreadcrumb,
  ChannelInfo,
  SentMessage,
  MessageHandler,
} from "./channel.js";

// ── Fake implementations for compile-time verification ─────────

/**
 * A minimal no-op ChannelProvider that satisfies the interface
 * contract.  Used to verify that the interface can be implemented
 * without importing any concrete adapter.
 */
class FakeChannelProvider implements ChannelProvider {
  readonly name = "fake";
  readonly providerId = "fake-provider";
  isConnected = false;

  connect(): Promise<void> {
    this.isConnected = true;
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    this.isConnected = false;
    return Promise.resolve();
  }
  listChannels(): Promise<ChannelInfo[]> {
    return Promise.resolve([]);
  }
  channelExists(_channelId: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = _channelId;
    return Promise.resolve(false);
  }
  onMessage(handler: MessageHandler): void {
    // Store handler reference for test verification
    void handler;
  }
  sendMessage(
    channelId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _content: ChannelContent,
  ): Promise<SentMessage> {
    return Promise.resolve({
      id: `msg-${channelId}`,
      channelId,
      timestamp: new Date(),
    });
  }
  updateMessage(
    channelId: string,
    messageId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _content: ChannelContent,
  ): Promise<void> {
    void channelId;
    void messageId;
    return Promise.resolve();
  }
  deleteMessage(channelId: string, messageId: string): Promise<void> {
    void channelId;
    void messageId;
    return Promise.resolve();
  }
  sendBreadcrumb(breadcrumb: ChannelBreadcrumb): Promise<void> {
    void breadcrumb;
    return Promise.resolve();
  }
  updateBreadcrumb(
    breadcrumbId: string,
    update: Partial<Pick<ChannelBreadcrumb, "status" | "description">>,
  ): Promise<void> {
    void breadcrumbId;
    void update;
    return Promise.resolve();
  }
}

describe("ChannelProvider interface", () => {
  it("can be implemented by a fake class", () => {
    const provider = new FakeChannelProvider();
    expect(provider.name).toBe("fake");
    expect(provider.providerId).toBe("fake-provider");
  });

  it("connect/disconnect toggle isConnected", async () => {
    const provider = new FakeChannelProvider();
    expect(provider.isConnected).toBe(false);
    await provider.connect();
    expect(provider.isConnected).toBe(true);
    await provider.disconnect();
    expect(provider.isConnected).toBe(false);
  });
});

describe("ChannelParticipant", () => {
  it("accepts valid participant shape", () => {
    const p: ChannelParticipant = {
      id: "u1",
      displayName: "Alice",
      kind: "human",
      platform: "den-channels",
    };
    expect(p.kind).toBe("human");
    expect(p.platform).toBe("den-channels");
  });
});

describe("ChannelContent", () => {
  it("text kind", () => {
    const c: ChannelContent = { kind: "text", text: "hello" };
    expect(c.kind).toBe("text");
  });

  it("media kind", () => {
    const c: ChannelContent = {
      kind: "media",
      url: "https://example.com/img.png",
      mimeType: "image/png",
    };
    expect(c.kind).toBe("media");
    expect(c.url).toBe("https://example.com/img.png");
  });

  it("mixed kind", () => {
    const c: ChannelContent = {
      kind: "mixed",
      parts: [
        { kind: "text", text: "check this" },
        {
          kind: "media",
          url: "https://example.com/img.png",
          mimeType: "image/png",
        },
      ],
    };
    expect(c.kind).toBe("mixed");
    expect(c.parts.length).toBe(2);
  });
});
