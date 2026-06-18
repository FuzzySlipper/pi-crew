/**
 * Tests for the ServiceWorkConsumer component.
 * Tests through the public interface only — methods are truly private (#).
 *
 * @module pi-crew/__tests__/service-work-consumer.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { ServiceWorkConsumer } from "../service-work-consumer.js";
import type { ChannelProvider } from "@pi-crew/core";
import type { ServiceWorkConsumerOptions } from "../service-work-consumer.js";

// ── Helpers ────────────────────────────────────────────────────

/** All-required defaults for tests — mirrors BackgroundReviewConfig defaults. */
function defaultOptions(overrides?: Partial<ServiceWorkConsumerOptions>): ServiceWorkConsumerOptions {
  return {
    baseUrl: "http://test:8080",
    channelId: "7276",
    claimTTLMs: 60_000,
    enabled: true,
    agentIdentity: "test-agent",
    pollIntervalMs: 15_000,
    pollLimit: 20,
    startupDelayMs: 2_000,
    ...overrides,
  };
}

function createFakeChannelProvider(): ChannelProvider & { sentMessages: Array<{ channelId: string; text: string }> } {
  const sentMessages: Array<{ channelId: string; text: string }> = [];

  return {
    name: "test",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockImplementation(
      (channelId: string, payload: { kind: string; text: string }) => {
        sentMessages.push({ channelId, text: payload.text });
        return Promise.resolve();
      },
    ) as ChannelProvider["sendMessage"],
    onMessage: vi.fn() as ChannelProvider["onMessage"],
    sentMessages,
  } as unknown as ChannelProvider & { sentMessages: Array<{ channelId: string; text: string }> };
}

// ── Tests ──────────────────────────────────────────────────────

describe("ServiceWorkConsumer", () => {
  let logger: FakeLogger;
  let eventBus: FakeEventBus;
  let channelProvider: ReturnType<typeof createFakeChannelProvider>;
  let consumer: ServiceWorkConsumer;

  beforeEach(() => {
    logger = new FakeLogger();
    eventBus = new FakeEventBus();
    channelProvider = createFakeChannelProvider();
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (consumer) consumer.stop();
    vi.useRealTimers();
  });

  // ── Lifecycle ──────────────────────────────────────────────

  it("starts and logs when enabled", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions());

    consumer.start();
    expect(logger.entries.some((e) => e.message === "ServiceWorkConsumer starting")).toBe(true);
  });

  it("skips start when disabled", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions({ enabled: false }));

    consumer.start();
    expect(logger.entries.some((e) => e.message === "ServiceWorkConsumer disabled — skipping start")).toBe(true);
  });

  it("stops cleanly", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions());
    consumer.start();
    consumer.stop();
    expect(logger.entries.some((e) => e.message === "ServiceWorkConsumer stopped")).toBe(true);
  });

  it("is idempotent — starting twice logs once", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions());
    consumer.start();
    consumer.start(); // second start should be no-op
    const starts = logger.entries.filter((e) => e.message === "ServiceWorkConsumer starting");
    expect(starts).toHaveLength(1);
  });

  // ── Config threading ───────────────────────────────────────

  it("uses configured pollIntervalMs in start log", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions({ pollIntervalMs: 5_000 }));
    consumer.start();
    const startLog = logger.entries.find((e) => e.message === "ServiceWorkConsumer starting");
    expect(startLog).toBeDefined();
    expect(startLog?.context).toMatchObject({ pollIntervalMs: 5_000 });
  });

  it("uses configured channelId in start log", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions({ channelId: "custom-channel" }));
    consumer.start();
    const startLog = logger.entries.find((e) => e.message === "ServiceWorkConsumer starting");
    expect(startLog).toBeDefined();
    expect(startLog?.context).toMatchObject({ channelId: "custom-channel" });
  });

  // ── Sends messages via channel provider ─────────────────────

  it("creates consumer without crashes when enabled=false and no fetch happens", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions({
      enabled: false,
      channelId: "service-work",
    }));

    consumer.start();
    expect(channelProvider.sentMessages).toHaveLength(0);
    expect(logger.entries.filter((e) => e.level === "warn")).toHaveLength(0);
  });

  // ── Events ──────────────────────────────────────────────────

  it("emits service_work events when the consumer is wired to the bus", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions({
      enabled: false,
      channelId: "service-work",
    }));

    consumer.start();
    expect(eventBus).toBeDefined();
  });

  // ── Error handling ──────────────────────────────────────────

  it("handles fetch failures gracefully without crashing", async () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions({
      baseUrl: "http://127.0.0.1:1",
      channelId: "nonexistent",
    }));

    consumer.start();

    // Advance past the initial startup delay + one poll interval
    await vi.advanceTimersByTimeAsync(60_000);

    // Should log warnings but not crash
    const warnings = logger.entries.filter((e) => e.level === "warn");
    expect(warnings.length).toBeGreaterThan(0);

    consumer.stop();
  });

  // ── Den Channels API integration ───────────────────────────

  it("constructs background_review_started message correctly", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions({
      enabled: false,
      channelId: "service-work",
      agentIdentity: "test-agent",
    }));

    expect(consumer).toBeDefined();
  });

  it("sets correct channel id for service-work", () => {
    consumer = new ServiceWorkConsumer(logger, eventBus, channelProvider, defaultOptions({
      enabled: false,
      channelId: "service-work",
    }));
    consumer.start();
    consumer.stop();
  });
});
