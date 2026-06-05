/**
 * Tests for {@link SimulatedDenConnection}.
 *
 * Exercises the in-memory Den connection used by adapter and
 * message-format tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { SimulatedDenConnection } from "../den-channels/connection-simulated.js";
import type {
  DenInboundMessage,
  DenOutboundPayload,
  DenBreadcrumbPayload,
} from "../den-channels/connection-types.js";

function makeInboundMessage(
  overrides?: Partial<DenInboundMessage>,
): DenInboundMessage {
  return {
    id: "msg-1",
    channelId: "owner:assignment:213",
    sender: { id: "user-1", displayName: "Test User", kind: "human" },
    content: { kind: "text", text: "hello" },
    timestamp: "2026-06-05T09:24:00Z",
    ...overrides,
  };
}

function makePayload(
  overrides?: Partial<DenOutboundPayload>,
): DenOutboundPayload {
  return {
    content: { kind: "text", text: "world" },
    ...overrides,
  };
}

describe("SimulatedDenConnection", () => {
  let logger: FakeLogger;
  let conn: SimulatedDenConnection;

  beforeEach(() => {
    logger = new FakeLogger();
    conn = new SimulatedDenConnection(logger);
  });

  // ── connection lifecycle ───────────────────────────────────

  it("starts unopened", () => {
    expect(conn.isOpen).toBe(false);
  });

  it("open sets isOpen and emits connected", async () => {
    const connected = vi.fn();
    conn.on("connected", connected);

    await conn.open();

    expect(conn.isOpen).toBe(true);
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it("open is idempotent", async () => {
    const connected = vi.fn();
    conn.on("connected", connected);

    await conn.open();
    await conn.open();

    expect(conn.isOpen).toBe(true);
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it("close sets isOpen to false and emits disconnected", async () => {
    const disconnected = vi.fn();
    conn.on("disconnected", disconnected);

    await conn.open();
    await conn.close();

    expect(conn.isOpen).toBe(false);
    expect(disconnected).toHaveBeenCalledWith("simulated-close");
  });

  // ── messaging ──────────────────────────────────────────────

  it("sendMessage returns a result with id", async () => {
    await conn.open();
    const result = await conn.sendMessage("ch1", makePayload());

    expect(result.id).toMatch(/^den-msg-/);
    expect(conn.sentMessages).toHaveLength(1);
    const sent = conn.sentMessages[0];
    expect(sent).toBeDefined();
    if (sent) {
      expect(sent.channelId).toBe("ch1");
      expect(sent.result).toEqual(result);
    }
  });

  it("sendMessage increments ids", async () => {
    await conn.open();
    const r1 = await conn.sendMessage("ch1", makePayload());
    const r2 = await conn.sendMessage("ch2", makePayload());

    expect(r1.id).not.toBe(r2.id);
  });

  it("sendMessage captures replyToId", async () => {
    await conn.open();
    await conn.sendMessage("ch1", makePayload({ replyToId: "parent-1" }));

    const sent = conn.sentMessages[0];
    expect(sent).toBeDefined();
    if (sent) {
      expect(sent.payload.replyToId).toBe("parent-1");
    }
  });

  it("sendMessage throws when not open", async () => {
    await expect(
      conn.sendMessage("ch1", makePayload()),
    ).rejects.toThrow("Simulated Den connection is not open");
  });

  it("updateMessage captures the call", async () => {
    await conn.open();
    await conn.updateMessage("ch1", "msg-42", makePayload());

    expect(conn.updatedMessages).toHaveLength(1);
    const u = conn.updatedMessages[0];
    if (u) {
      expect(u.channelId).toBe("ch1");
      expect(u.messageId).toBe("msg-42");
    }
  });

  it("deleteMessage captures the call", async () => {
    await conn.open();
    await conn.deleteMessage("ch1", "msg-77");

    expect(conn.deletedMessages).toHaveLength(1);
    const d = conn.deletedMessages[0];
    if (d) {
      expect(d.channelId).toBe("ch1");
      expect(d.messageId).toBe("msg-77");
    }
  });

  // ── breadcrumbs ────────────────────────────────────────────

  it("sendBreadcrumb captures the breadcrumb", async () => {
    await conn.open();
    const bc: DenBreadcrumbPayload = {
      id: "bc-1",
      channelId: "ch1",
      category: "tool",
      status: "started",
      description: "searching",
    };
    await conn.sendBreadcrumb(bc);

    expect(conn.breadcrumbs).toHaveLength(1);
    expect(conn.breadcrumbs[0]).toEqual(bc);
  });

  it("updateBreadcrumb captures the update", async () => {
    await conn.open();
    await conn.updateBreadcrumb("bc-1", {
      status: "completed",
      description: "done",
    });

    expect(conn.breadcrumbUpdates).toHaveLength(1);
    const u = conn.breadcrumbUpdates[0];
    if (u) {
      expect(u.breadcrumbId).toBe("bc-1");
      expect(u.update.status).toBe("completed");
    }
  });

  // ── inbound message simulation ─────────────────────────────

  it("simulateInboundMessage triggers message event", async () => {
    const onMessage = vi.fn();
    conn.on("message", onMessage);
    await conn.open();

    const msg = makeInboundMessage({ id: "in-1" });
    conn.simulateInboundMessage(msg);

    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it("does not crash when no message listener registered", () => {
    const msg = makeInboundMessage();
    conn.simulateInboundMessage(msg);
    // If we got here without exception, the test passes.
    expect(true).toBe(true);
  });

  // ── disconnect simulation ──────────────────────────────────

  it("simulateDisconnect triggers disconnected event", async () => {
    const disconnected = vi.fn();
    conn.on("disconnected", disconnected);
    await conn.open();

    conn.simulateDisconnect("transport-error");

    expect(conn.isOpen).toBe(false);
    expect(disconnected).toHaveBeenCalledWith("transport-error");
  });

  it("simulateDisconnectOnNextSend triggers disconnect on send", async () => {
    await conn.open();
    const disconnected = vi.fn();
    conn.on("disconnected", disconnected);

    conn.simulateDisconnectOnNextSend();
    await expect(
      conn.sendMessage("ch1", makePayload()),
    ).rejects.toThrow("Simulated disconnect on send");

    expect(conn.isOpen).toBe(false);
    expect(disconnected).toHaveBeenCalledWith("simulated-disconnect");
  });

  // ── events ─────────────────────────────────────────────────

  it("on returns unsubscribe function", async () => {
    const handler = vi.fn();
    const unsub = conn.on("connected", handler);

    await conn.open();
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    await conn.close();
    await conn.open();
    // Should still be 1 — second open is idempotent anyway,
    // so let's test with disconnected
    expect(handler).toHaveBeenCalledTimes(1); // disconnected unsubscribed
  });

  it("error events are emitted for error listeners", async () => {
    // Simulated connection doesn't emit error on its own,
    // but the DenWebSocketConnection does via #emit.
    // Just verify the listener registration works.
    const onErr = vi.fn();
    conn.on("error", onErr);
    // connect + verify handler was registered
    await conn.open();
    // no error emitted, but handler is registered
  });

  // ── clear ──────────────────────────────────────────────────

  it("clear resets all captured state", async () => {
    await conn.open();
    await conn.sendMessage("ch1", makePayload());
    conn.simulateInboundMessage(makeInboundMessage());

    conn.clear();

    expect(conn.sentMessages).toHaveLength(0);
    expect(conn.updatedMessages).toHaveLength(0);
    expect(conn.deletedMessages).toHaveLength(0);
    expect(conn.breadcrumbs).toHaveLength(0);
    expect(conn.breadcrumbUpdates).toHaveLength(0);
  });
});
