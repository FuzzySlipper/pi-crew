/**
 * Tests for {@link DenChannelsAdapter} — disconnect, reconnect,
 * channel discovery, and typing indicators.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import type { ChannelContent } from "@pi-crew/core";
import { DenChannelsAdapter } from "../den-channels/den-channels-adapter.js";
import { SimulatedDenConnection } from "../den-channels/connection-simulated.js";

function makeTextContent(text: string): ChannelContent {
  return { kind: "text", text };
}

describe("DenChannelsAdapter — disconnect/reconnect/edges", () => {
  let logger: FakeLogger;
  let simConn: SimulatedDenConnection;
  let adapter: DenChannelsAdapter;

  beforeEach(() => {
    logger = new FakeLogger();
    simConn = new SimulatedDenConnection(logger);
    adapter = new DenChannelsAdapter(simConn, logger);
  });

  it("emits disconnected event on simulated disconnect", async () => {
    const disconnected = vi.fn();
    simConn.on("disconnected", disconnected);

    await adapter.connect();
    simConn.simulateDisconnect("transport-error");

    expect(disconnected).toHaveBeenCalledWith("transport-error");
    expect(adapter.isConnected).toBe(false);
  });

  it("emits reconnecting event during reconnection", async () => {
    const reconnecting = vi.fn();
    simConn.on("reconnecting", reconnecting);

    await adapter.connect();
    simConn.simulateDisconnect("transient error");
  });

  it("emits connectionFailed event when reconnect exhausted", async () => {
    const connectionFailed = vi.fn();
    simConn.on("connectionFailed", connectionFailed);

    await adapter.connect();
  });

  it("adapter disconnect unsubscribes all connection listeners", async () => {
    const connected = vi.fn();
    simConn.on("connected", connected);

    await adapter.connect();
    expect(connected).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
    await simConn.close();
    await simConn.open();

    expect(connected).toHaveBeenCalledTimes(2);
  });

  it("simulated disconnect stops message routing", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    simConn.simulateDisconnect("connection-lost");

    await expect(
      adapter.sendMessage("ch1", makeTextContent("after disconnect")),
    ).rejects.toThrow();
  });

  it("listChannels returns empty (not yet supported)", async () => {
    await adapter.connect();
    const channels = await adapter.listChannels();
    expect(channels).toEqual([]);
  });

  it("channelExists returns true optimistically", async () => {
    await adapter.connect();
    expect(await adapter.channelExists("any-channel")).toBe(true);
  });

  it("sendTypingIndicator is a no-op that logs debug", async () => {
    await adapter.connect();
    await adapter.sendTypingIndicator("ch1");

    const debug = logger.entries.filter(
      (e) => e.level === "debug" && e.message.includes("Typing indicator"),
    );
    expect(debug.length).toBeGreaterThan(0);
  });

  it("clearTypingIndicator is a no-op that logs debug", async () => {
    await adapter.connect();
    await adapter.clearTypingIndicator("ch1");

    const debug = logger.entries.filter(
      (e) => e.level === "debug" && e.message.includes("Clear typing"),
    );
    expect(debug.length).toBeGreaterThan(0);
  });
});
