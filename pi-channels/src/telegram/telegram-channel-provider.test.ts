/**
 * Tests for {@link TelegramChannelProvider}.
 *
 * Uses a simulated {@link TelegramConnection} fake to verify:
 *
 * - Provider connects and subscribes to updates
 * - Inbound text messages trigger MessageHandler with correct ChannelMessage
 * - Inbound photo/document messages produce correct ChannelContent
 * - Callback queries are translated to text messages
 * - Chat allowlist filtering works
 * - Outbound sendMessage produces correct Telegram API params
 * - Breadcrumb send produces formatted status messages
 * - Typing indicators call sendChatAction
 * - Single-session routing: all chats → one handler
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import type {
  ChannelProvider,
  ChannelMessage,
  ChannelContent,
  ChannelBreadcrumb,
} from "@pi-crew/core";
import { TelegramChannelProvider } from "./telegram-channel-provider.js";
import type {
  TelegramConnection,
  TelegramConnectionEvents,
  TelegramUpdate,
  TelegramMessage,
  TelegramSendMessageParams,
  TelegramEditMessageTextParams,
  TelegramDeleteMessageParams,
  TelegramSendChatActionParams,
  TelegramGetFileParams,
  TelegramFile,
  TelegramProviderConfig,
} from "./telegram-types.js";

// ── Fake Telegram Connection ──────────────────────────────────────

class FakeTelegramConnection implements TelegramConnection {
  #open = false;
  #listeners = new Map<keyof TelegramConnectionEvents, Set<(...args: unknown[]) => void>>();
  public sentMessages: TelegramSendMessageParams[] = [];
  public editedMessages: TelegramEditMessageTextParams[] = [];
  public deletedMessages: TelegramDeleteMessageParams[] = [];
  public chatActions: TelegramSendChatActionParams[] = [];
  #nextMessageId = 100;

  get isOpen(): boolean {
    return this.#open;
  }

  async open(): Promise<void> {
    this.#open = true;
    this.#emit("connected");
  }

  async close(): Promise<void> {
    this.#open = false;
    this.#emit("disconnected", "closed");
  }

  async sendMessage(params: TelegramSendMessageParams): Promise<TelegramMessage> {
    this.sentMessages.push(params);
    const id = this.#nextMessageId++;
    return {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(params.chat_id), type: "private" },
      text: params.text,
    };
  }

  async editMessageText(params: TelegramEditMessageTextParams): Promise<TelegramMessage> {
    this.editedMessages.push(params);
    return {
      message_id: params.message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(params.chat_id), type: "private" },
      text: params.text,
    };
  }

  async deleteMessage(params: TelegramDeleteMessageParams): Promise<boolean> {
    this.deletedMessages.push(params);
    return true;
  }

  async sendChatAction(params: TelegramSendChatActionParams): Promise<boolean> {
    this.chatActions.push(params);
    return true;
  }

  async getFile(_params: TelegramGetFileParams): Promise<TelegramFile> {
    return {
      file_id: "fake-file-id",
      file_unique_id: "fake-unique-id",
      file_path: "photos/file_0.jpg",
    };
  }

  on<K extends keyof TelegramConnectionEvents>(
    event: K,
    listener: TelegramConnectionEvents[K],
  ): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as (...args: unknown[]) => void);
    return () => {
      const s = this.#listeners.get(event);
      if (s) s.delete(listener as (...args: unknown[]) => void);
    };
  }

  // ── Test helpers ────────────────────────────────────────────

  simulateUpdate(update: TelegramUpdate): void {
    this.#emit("update", update);
  }

  simulateError(error: Error): void {
    this.#emit("error", error);
  }

  #emit<K extends keyof TelegramConnectionEvents>(
    event: K,
    ...args: Parameters<TelegramConnectionEvents[K]>
  ): void {
    const set = this.#listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener(...(args as unknown[]));
      }
    }
  }
}

// ── Test helpers ────────────────────────────────────────────────

function makeTextUpdate(
  text: string,
  overrides?: Partial<TelegramUpdate["message"]>,
): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      from: { id: 12345, is_bot: false, first_name: "Alice" },
      date: Math.floor(Date.now() / 1000),
      chat: { id: -1001234567890, type: "supergroup" },
      text,
      ...overrides,
    },
  };
}

function makePhotoUpdate(caption?: string): TelegramUpdate {
  return {
    update_id: 2,
    message: {
      message_id: 43,
      from: { id: 12345, is_bot: false, first_name: "Alice" },
      date: Math.floor(Date.now() / 1000),
      chat: { id: -1001234567890, type: "supergroup" },
      photo: [
        { file_id: "small-photo-id", file_unique_id: "u1", width: 90, height: 90 },
        { file_id: "large-photo-id", file_unique_id: "u2", width: 800, height: 600 },
      ],
      caption,
    },
  };
}

function makeCallbackUpdate(data: string): TelegramUpdate {
  return {
    update_id: 3,
    callback_query: {
      id: "cbq-1",
      from: { id: 12345, is_bot: false, first_name: "Alice" },
      message: {
        message_id: 42,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -1001234567890, type: "supergroup" },
      },
      data,
    },
  };
}

function makeDocumentUpdate(): TelegramUpdate {
  return {
    update_id: 4,
    message: {
      message_id: 44,
      from: { id: 12345, is_bot: false, first_name: "Alice" },
      date: Math.floor(Date.now() / 1000),
      chat: { id: -1001234567890, type: "supergroup" },
      document: {
        file_id: "doc-file-id",
        file_unique_id: "doc-unique-id",
        file_name: "report.pdf",
        mime_type: "application/pdf",
      },
    },
  };
}

const DEFAULT_CONFIG: TelegramProviderConfig = {
  tokenEnv: "TELEGRAM_BOT_TOKEN",
};

// ── Tests ───────────────────────────────────────────────────────

describe("TelegramChannelProvider", () => {
  let logger: FakeLogger;
  let fakeConn: FakeTelegramConnection;
  let provider: TelegramChannelProvider;

  beforeEach(() => {
    logger = new FakeLogger();
    fakeConn = new FakeTelegramConnection();
    provider = new TelegramChannelProvider(fakeConn, logger, DEFAULT_CONFIG);
  });

  // ── identity ────────────────────────────────────────────────

  it("satisfies the ChannelProvider interface", () => {
    const p: ChannelProvider = provider;
    expect(p).toBe(provider);
  });

  it("has default identity values", () => {
    expect(provider.name).toBe("Telegram Bot");
    expect(provider.providerId).toBe("telegram");
  });

  it("accepts custom identity via config", () => {
    const p = new TelegramChannelProvider(fakeConn, logger, DEFAULT_CONFIG, {
      name: "My Bot",
      providerId: "my-telegram",
    });
    expect(p.name).toBe("My Bot");
    expect(p.providerId).toBe("my-telegram");
  });

  // ── connection lifecycle ────────────────────────────────────

  it("starts disconnected", () => {
    expect(provider.isConnected).toBe(false);
  });

  it("connect opens the connection", async () => {
    await provider.connect();
    expect(provider.isConnected).toBe(true);
    expect(fakeConn.isOpen).toBe(true);
  });

  it("connect is idempotent", async () => {
    await provider.connect();
    await provider.connect();
    expect(provider.isConnected).toBe(true);
  });

  it("disconnect closes the connection", async () => {
    await provider.connect();
    await provider.disconnect();
    expect(provider.isConnected).toBe(false);
  });

  // ── inbound text message ────────────────────────────────────

  it("receives a text message and triggers MessageHandler", async () => {
    const handler = vi.fn();
    provider.onMessage(handler);
    await provider.connect();

    fakeConn.simulateUpdate(makeTextUpdate("hello from telegram"));

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    const msg = handler.mock.calls[0]?.[0] as ChannelMessage | undefined;
    expect(msg).toBeDefined();
    if (msg) {
      expect(msg.id).toBe("42");
      expect(msg.channelId).toBe("-1001234567890");
      expect(msg.sender.id).toBe("12345");
      expect(msg.sender.displayName).toBe("Alice");
      expect(msg.sender.kind).toBe("human");
      expect(msg.sender.platform).toBe("telegram");
      if (msg.content.kind === "text") {
        expect(msg.content.text).toBe("hello from telegram");
      }
      expect(msg.timestamp).toBeInstanceOf(Date);
    }
  });

  // ── inbound photo message ───────────────────────────────────

  it("handles photo messages with caption", async () => {
    const handler = vi.fn();
    provider.onMessage(handler);
    await provider.connect();

    fakeConn.simulateUpdate(makePhotoUpdate("check this out"));

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    const msg = handler.mock.calls[0]?.[0] as ChannelMessage | undefined;
    expect(msg).toBeDefined();
    if (msg) {
      expect(msg.content.kind).toBe("mixed");
      if (msg.content.kind === "mixed") {
        expect(msg.content.parts).toHaveLength(2);
        expect(msg.content.parts[0]?.kind).toBe("media");
        expect(msg.content.parts[1]?.kind).toBe("text");
      }
    }
  });

  it("handles photo messages without caption", async () => {
    const handler = vi.fn();
    provider.onMessage(handler);
    await provider.connect();

    fakeConn.simulateUpdate(makePhotoUpdate());

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    const msg = handler.mock.calls[0]?.[0] as ChannelMessage | undefined;
    expect(msg).toBeDefined();
    if (msg) {
      expect(msg.content.kind).toBe("media");
    }
  });

  // ── inbound document message ────────────────────────────────

  it("handles document messages", async () => {
    const handler = vi.fn();
    provider.onMessage(handler);
    await provider.connect();

    fakeConn.simulateUpdate(makeDocumentUpdate());

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    const msg = handler.mock.calls[0]?.[0] as ChannelMessage | undefined;
    expect(msg).toBeDefined();
    if (msg) {
      expect(msg.content.kind).toBe("media");
      if (msg.content.kind === "media") {
        expect(msg.content.mimeType).toBe("application/pdf");
      }
    }
  });

  // ── callback queries ────────────────────────────────────────

  it("translates callback queries to text messages", async () => {
    const handler = vi.fn();
    provider.onMessage(handler);
    await provider.connect();

    fakeConn.simulateUpdate(makeCallbackUpdate("button_pressed"));

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    const msg = handler.mock.calls[0]?.[0] as ChannelMessage | undefined;
    expect(msg).toBeDefined();
    if (msg) {
      expect(msg.content.kind).toBe("text");
      if (msg.content.kind === "text") {
        expect(msg.content.text).toBe("button_pressed");
      }
      expect(msg.metadata?.["isCallbackQuery"]).toBe(true);
    }
  });

  // ── chat allowlist ──────────────────────────────────────────

  it("filters messages from non-allowed chats", async () => {
    const restrictedProvider = new TelegramChannelProvider(
      fakeConn,
      logger,
      { ...DEFAULT_CONFIG, allowedChats: ["-1009999999999"] },
    );
    const handler = vi.fn();
    restrictedProvider.onMessage(handler);
    await restrictedProvider.connect();

    // This update comes from chat -1001234567890, which is NOT in the allowlist
    fakeConn.simulateUpdate(makeTextUpdate("should be filtered"));

    // Give it a moment to process
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).not.toHaveBeenCalled();
  });

  it("allows messages from allowed chats", async () => {
    const restrictedProvider = new TelegramChannelProvider(
      fakeConn,
      logger,
      { ...DEFAULT_CONFIG, allowedChats: ["-1001234567890"] },
    );
    const handler = vi.fn();
    restrictedProvider.onMessage(handler);
    await restrictedProvider.connect();

    fakeConn.simulateUpdate(makeTextUpdate("should pass"));

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );
  });

  // ── outbound sendMessage ────────────────────────────────────

  it("sends a text message with MarkdownV2 formatting", async () => {
    await provider.connect();

    const content: ChannelContent = { kind: "text", text: "Hello *world*" };
    const result = await provider.sendMessage("-1001234567890", content);

    expect(result.id).toBeDefined();
    expect(result.channelId).toBe("-1001234567890");
    expect(fakeConn.sentMessages).toHaveLength(1);
    expect(fakeConn.sentMessages[0]?.parse_mode).toBe("MarkdownV2");
    expect(fakeConn.sentMessages[0]?.chat_id).toBe("-1001234567890");
  });

  // ── outbound updateMessage ──────────────────────────────────

  it("edits an existing message", async () => {
    await provider.connect();

    const content: ChannelContent = { kind: "text", text: "updated text" };
    await provider.updateMessage("-1001234567890", "42", content);

    expect(fakeConn.editedMessages).toHaveLength(1);
    expect(fakeConn.editedMessages[0]?.message_id).toBe(42);
    expect(fakeConn.editedMessages[0]?.parse_mode).toBe("MarkdownV2");
  });

  // ── outbound deleteMessage ──────────────────────────────────

  it("deletes a message", async () => {
    await provider.connect();

    await provider.deleteMessage("-1001234567890", "42");

    expect(fakeConn.deletedMessages).toHaveLength(1);
    expect(fakeConn.deletedMessages[0]?.message_id).toBe(42);
  });

  // ── breadcrumbs ─────────────────────────────────────────────

  it("sends breadcrumbs as formatted status messages", async () => {
    await provider.connect();

    const breadcrumb: ChannelBreadcrumb = {
      id: "bc-1",
      channelId: "-1001234567890",
      category: "tool",
      status: "started",
      description: "running web_search",
    };

    await provider.sendBreadcrumb(breadcrumb);

    expect(fakeConn.sentMessages).toHaveLength(1);
    expect(fakeConn.sentMessages[0]?.text).toContain("tool");
    // MarkdownV2 escapes underscore: web_search → web\_search
    expect(fakeConn.sentMessages[0]?.text).toContain("web\\_search");
  });

  // ── typing indicators ───────────────────────────────────────

  it("sends typing indicator via sendChatAction", async () => {
    await provider.connect();

    await provider.sendTypingIndicator!("-1001234567890");

    expect(fakeConn.chatActions).toHaveLength(1);
    expect(fakeConn.chatActions[0]?.action).toBe("typing");
  });

  // ── channel discovery ───────────────────────────────────────

  it("tracks known chats from inbound messages", async () => {
    const handler = vi.fn();
    provider.onMessage(handler);
    await provider.connect();

    fakeConn.simulateUpdate(makeTextUpdate("hello"));

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    const channels = await provider.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.id).toBe("-1001234567890");

    const exists = await provider.channelExists("-1001234567890");
    expect(exists).toBe(true);

    const notExists = await provider.channelExists("unknown-chat");
    expect(notExists).toBe(false);
  });

  // ── single-session routing ──────────────────────────────────

  it("routes messages from different chats to the same handler", async () => {
    const handler = vi.fn();
    provider.onMessage(handler);
    await provider.connect();

    // Message from chat A
    fakeConn.simulateUpdate(makeTextUpdate("from chat A", {
      message_id: 1,
      chat: { id: 111, type: "private" },
    }));

    // Message from chat B
    fakeConn.simulateUpdate(makeTextUpdate("from chat B", {
      message_id: 2,
      chat: { id: 222, type: "group" },
    }));

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(2);
      },
      { timeout: 1000 },
    );

    // Both messages went to the same handler — single session
    const msg1 = handler.mock.calls[0]?.[0] as ChannelMessage;
    const msg2 = handler.mock.calls[1]?.[0] as ChannelMessage;
    expect(msg1.channelId).toBe("111");
    expect(msg2.channelId).toBe("222");
  });

  // ── error handling ──────────────────────────────────────────

  it("logs warning when no handler is registered", async () => {
    await provider.connect();
    fakeConn.simulateUpdate(makeTextUpdate("no handler"));

    // Give it a moment
    await new Promise((r) => setTimeout(r, 50));

    const warnEntries = logger.entries.filter((e) => e.level === "warn");
    expect(
      warnEntries.some((e) =>
        e.message.includes("No message handler registered"),
      ),
    ).toBe(true);
  });

  it("logs error when handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("handler boom"));
    provider.onMessage(handler);
    await provider.connect();

    fakeConn.simulateUpdate(makeTextUpdate("will fail"));

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );

    // Give the error handler time to log
    await new Promise((r) => setTimeout(r, 50));

    const errorEntries = logger.entries.filter((e) => e.level === "error");
    expect(
      errorEntries.some((e) =>
        e.message.includes("Message handler threw"),
      ),
    ).toBe(true);
  });
});
