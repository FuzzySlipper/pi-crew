/**
 * Unit tests for DenHttpDirectAgentConnection.
 *
 * Covers: event-to-DenInboundMessage mapping, cursor advancement,
 * lifecycle telemetry, gateway_delivery posts, and polling loop
 * behavior.
 *
 * @module pi-channels/__tests__/connection-http
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import { FakeLogger } from "@pi-crew/core";

import { DenHttpDirectAgentConnection } from "../den-channels/connection-http.js";
import type {
  DenHttpConnectionConfig,
  CursorStore,
  DenInboundMessage,
} from "../den-channels/connection-types.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeConfig(
  overrides?: Partial<DenHttpConnectionConfig>,
): DenHttpConnectionConfig {
  return {
    baseUrl: "http://192.168.1.10:18081",
    projectId: "pi-crew",
    memberIdentity: "pi-crew-gateway",
    token: "test-token",
    pollIntervalMs: 5000,
    pollLimit: 10,
    allowLegacyDirectPolling: true,
    ...overrides,
  };
}

class InMemoryCursorStore implements CursorStore {
  readonly #store = new Map<string, string>();

  read(key: string): Promise<string | null> {
    return Promise.resolve(this.#store.get(key) ?? null);
  }

  write(key: string, value: string): Promise<void> {
    this.#store.set(key, value);
    return Promise.resolve();
  }
}

// ── Mock fetch helpers ───────────────────────────────────────────

function urlFromInput(input: string | URL): string {
  return input instanceof URL ? input.toString() : input;
}

function mockFetchFromJson(
  pollJson: unknown,
): ReturnType<typeof vi.fn> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return vi.fn((input: string | URL, _init?: RequestInit) => {
    const urlStr = urlFromInput(input);
    if (urlStr.includes("/api/direct-agent-events")) {
      return Promise.resolve(
        new Response(JSON.stringify(pollJson), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe("DenHttpDirectAgentConnection", () => {
  let logger: FakeLogger;
  let cursorStore: InMemoryCursorStore;

  beforeEach(() => {
    logger = new FakeLogger();
    cursorStore = new InMemoryCursorStore();
  });

  it("is not open before calling open()", () => {
    const conn = new DenHttpDirectAgentConnection(
      makeConfig(),
      logger,
      cursorStore,
    );
    expect(conn.isOpen).toBe(false);
  });

  it("opens and fires connected event", async () => {
    let fired = false;
    const conn = new DenHttpDirectAgentConnection(
      makeConfig(),
      logger,
      cursorStore,
    );
    conn.on("connected", () => {
      fired = true;
    });

    await conn.open();
    expect(conn.isOpen).toBe(true);
    expect(fired).toBe(true);

    await conn.close();
  });

  it("restores cursor on open", async () => {
    await cursorStore.write("den_channels_cursor", "42");

    const conn = new DenHttpDirectAgentConnection(
      makeConfig(),
      logger,
      cursorStore,
    );

    await conn.open();
    await conn.close();

    const found = logger.entries.find(
      (e) => e.message === "Restored Den Channels event cursor",
    );
    expect(found).toBeDefined();
    const ctx = found?.context as { cursor: unknown } | undefined;
    expect(ctx?.cursor).toBe(42);
  });

  it("fires disconnected on close", async () => {
    let reason = "";
    const conn = new DenHttpDirectAgentConnection(
      makeConfig(),
      logger,
      cursorStore,
    );
    conn.on("disconnected", (r) => {
      reason = r;
    });

    await conn.open();
    await conn.close();

    expect(conn.isOpen).toBe(false);
    expect(reason).toBe("http-close");
  });

  it("maps direct-agent event items to DenInboundMessage", async () => {
    const mockFetch = mockFetchFromJson({
      items: [
        {
          id: 3001,
          channelId: 604,
          sourceKind: "wake_event",
          sourceId: "direct-agent-message:604:pi-crew-gateway:abc",
          sourceProjectId: "pi-crew",
          targetProjectId: "pi-crew",
          targetTaskId: 2026,
          assignmentId: "380",
          workerRunId: "piw_test",
          workerRole: "coder",
          body: "Implement HTTP ingress",
          status: "recorded_pending_claim",
          createdAt: "2026-06-06T08:20:00Z",
        },
      ],
      nextAfterId: null,
      hasMore: false,
    });

    const received: DenInboundMessage[] = [];
    const conn = new DenHttpDirectAgentConnection(
      makeConfig({ pollLimit: 1 }),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    conn.on("message", (msg) => {
      received.push(msg);
    });

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await conn.close();

    expect(received.length).toBe(1);
    const msg = received[0];
    if (msg) {
      expect(msg.id).toBe("3001");
      expect(msg.channelId).toBe("604");
      expect(msg.sender.kind).toBe("system");
      expect(msg.content.kind).toBe("text");
      if (msg.content.kind === "text") {
        expect(msg.content.text).toBe("Implement HTTP ingress");
      }
      expect(msg.metadata).toBeDefined();
      const meta = msg.metadata as Record<string, unknown>;
      expect(meta.eventKind).toBe("direct-agent-event");
      expect(meta.assignmentId).toBe("380");
    }
  });

  it("advances cursor after handling events", async () => {
    const mockFetch = mockFetchFromJson([
      {
        id: 3001,
        channelId: 604,
        memberIdentity: "pi-crew-gateway",
        body: "msg1",
        createdAt: "2026-06-06T08:20:00Z",
      },
    ]);

    const conn = new DenHttpDirectAgentConnection(
      makeConfig({ pollLimit: 1 }),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await conn.close();

    const cursor = await cursorStore.read("den_channels_cursor");
    expect(cursor).toBe("3001");
  });

  it("skips gateway_delivery rows while preserving wake-event ingress and cursor safety", async () => {
    const postedGatewayBodies: string[] = [];
    const mockFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const urlStr = urlFromInput(input);
      if (urlStr.includes("/api/direct-agent-events")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: 3001,
                  channelId: 604,
                  sourceKind: "wake_event",
                  sourceId: "direct-agent-message:604:pi-crew-gateway:abc",
                  sourceProjectId: "pi-crew",
                  targetProjectId: "pi-crew",
                  targetTaskId: 2035,
                  body: "Please use NON_ECHO_RUNTIME_OK for 19+23.",
                  createdAt: "2026-06-06T10:35:00Z",
                },
                {
                  id: 3002,
                  channelId: 604,
                  sourceKind: "gateway_delivery",
                  sourceId: "3001",
                  senderIdentity: "pi-crew-gateway",
                  body: "NON_ECHO_RUNTIME_OK:42",
                  createdAt: "2026-06-06T10:35:01Z",
                },
              ],
              nextAfterId: null,
              hasMore: false,
            }),
            { status: 200 },
          ),
        );
      }
      if (urlStr.includes("/api/gateway/system-messages")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        postedGatewayBodies.push(bodyText);
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const received: DenInboundMessage[] = [];
    const conn = new DenHttpDirectAgentConnection(
      makeConfig({ pollLimit: 2 }),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );
    conn.on("message", (msg) => {
      received.push(msg);
    });

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await conn.close();

    expect(received.map((msg) => msg.id)).toEqual(["3001"]);
    expect(received[0]?.content).toEqual({
      kind: "text",
      text: "Please use NON_ECHO_RUNTIME_OK for 19+23.",
    });
    expect(postedGatewayBodies).toHaveLength(1);
    expect(postedGatewayBodies[0]).toContain("gateway_delivery");
    const cursor = await cursorStore.read("den_channels_cursor");
    expect(cursor).toBe("3002");
  });

  it("posts lifecycle telemetry events for each handled event", async () => {
    const postedUrls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const mockFetch = vi.fn((input: string | URL, _init?: RequestInit) => {
      const urlStr = urlFromInput(input);
      postedUrls.push(urlStr);
      if (urlStr.includes("/api/direct-agent-events")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: 3001,
                channelId: 604,
                memberIdentity: "pi-crew-gateway",
                body: "msg1",
                createdAt: "2026-06-06T08:20:00Z",
              },
            ]),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const conn = new DenHttpDirectAgentConnection(
      makeConfig({ pollLimit: 1 }),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await conn.close();

    const lifecycleUrls = postedUrls.filter((u) =>
      u.includes("/api/agent-work/lifecycle-events"),
    );
    expect(lifecycleUrls.length).toBe(5);

    const gatewayUrls = postedUrls.filter((u) =>
      u.includes("/api/gateway/system-messages"),
    );
    expect(gatewayUrls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to legacy activity events when canonical lifecycle POST fails server-side", async () => {
    const legacyBodies: string[] = [];
    const mockFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const urlStr = urlFromInput(input);
      if (urlStr.includes("/api/direct-agent-events")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: 3001,
                channelId: 604,
                memberIdentity: "pi-crew-gateway",
                sourceProjectId: "pi-crew",
                targetProjectId: "pi-crew",
                targetTaskId: 2044,
                workerRunId: "piw_lifecycle_probe",
                workerRole: "runtime-smoke",
                body: "msg1",
                createdAt: "2026-06-06T08:20:00Z",
              },
            ]),
            { status: 200 },
          ),
        );
      }
      if (urlStr.includes("/api/agent-work/lifecycle-events")) {
        return Promise.resolve(new Response("schema mismatch", { status: 500 }));
      }
      if (urlStr.includes("/api/channel-activity-events")) {
        if (typeof init?.body === "string") legacyBodies.push(init.body);
        return Promise.resolve(new Response("{\"status\":\"recorded\"}", { status: 200 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const conn = new DenHttpDirectAgentConnection(
      makeConfig({ pollLimit: 1 }),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await conn.close();

    expect(legacyBodies).toHaveLength(5);
    const payloads = legacyBodies.map((body) => JSON.parse(body) as Record<string, unknown>);
    expect(payloads.map((payload) => payload.eventType)).toEqual([
      "lifecycle_status",
      "lifecycle_status",
      "lifecycle_status",
      "lifecycle_status",
      "lifecycle_status",
    ]);
    expect(payloads.map((payload) => payload.status)).toEqual([
      "started",
      "started",
      "started",
      "interim",
      "completed",
    ]);
    expect(payloads.map((payload) => payload.deliveryStage)).toEqual([
      "observability",
      "observability",
      "observability",
      "observability",
      "observability",
    ]);
    const metadata = JSON.parse(String(payloads[0]?.metadataJson)) as Record<string, unknown>;
    expect(metadata.canonicalLifecycleEventType).toBe("runtime_received");
    expect(metadata.directAgentEventId).toBe("3001");
  });

  it("passes auth headers when token is set", async () => {
    const capturedHeaders: Array<Record<string, string>> = [];
    const mockFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const urlStr = urlFromInput(input);
      if (urlStr.includes("/api/direct-agent-events")) {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers) capturedHeaders.push(headers);
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const conn = new DenHttpDirectAgentConnection(
      makeConfig({ token: "secret-token" }),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await conn.close();

    expect(capturedHeaders.length).toBeGreaterThan(0);
    const h = capturedHeaders[0];
    if (h) {
      expect(h["Authorization"]).toBe("Bearer secret-token");
    }
  });

  it("skips events that have already been handled (cursor)", async () => {
    await cursorStore.write("den_channels_cursor", "3000");

    const pollUrls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const mockFetch = vi.fn((input: string | URL, _init?: RequestInit) => {
      const urlStr = urlFromInput(input);
      if (urlStr.includes("/api/direct-agent-events")) {
        pollUrls.push(urlStr);
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const conn = new DenHttpDirectAgentConnection(
      makeConfig({ pollLimit: 1 }),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await conn.close();

    const target = pollUrls.find((u) => u.includes("afterId=3000"));
    expect(target).toBeDefined();
  });
});
