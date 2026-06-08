/** Tests for Den HTTP direct-agent membership/subscription registration. */
import { describe, expect, it, beforeEach, vi } from "vitest";

import { ConnectionError, FakeLogger } from "@pi-crew/core";

import { DenHttpDirectAgentConnection } from "./connection-http.js";
import type { CursorStore, DenHttpConnectionConfig } from "./connection-types.js";

function makeConfig(overrides?: Partial<DenHttpConnectionConfig>): DenHttpConnectionConfig {
  return {
    baseUrl: "http://192.168.1.10:18081",
    projectId: "pi-crew",
    memberIdentity: "pi-crew-runner",
    token: "test-token",
    pollIntervalMs: 5_000,
    pollLimit: 1,
    subscription: {
      channelId: "604",
      profileIdentity: "pi-crew-runner",
      memberRole: "runner",
      agentInstanceId: "pi-crew-runner-live",
      sessionOwnerId: "owner:den-k8plus:pi-crew-runner",
      sessionId: "sess-pi-crew-runner-live",
      subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-live",
    },
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

function urlFromInput(input: string | URL): string {
  return input instanceof URL ? input.toString() : input;
}

describe("DenHttpDirectAgentConnection subscription registration", () => {
  let logger: FakeLogger;
  let cursorStore: InMemoryCursorStore;

  beforeEach(() => {
    logger = new FakeLogger();
    cursorStore = new InMemoryCursorStore();
  });

  it("upserts active membership and ordinary subscription before first poll", async () => {
    const calls: Array<{ readonly url: string; readonly body: Record<string, unknown> | null }> = [];
    const mockFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = urlFromInput(input);
      calls.push({ url, body: parseBody(init?.body) });
      if (url.includes("/api/channels/604/memberships")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 44,
              channelId: 604,
              memberType: "agent",
              memberIdentity: "pi-crew-runner",
              membershipStatus: "active",
              wakePolicy: "all_messages_except_self",
              createdAt: "2026-06-08T00:00:00Z",
              updatedAt: "2026-06-08T00:00:00Z",
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/api/channels/604/subscriptions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 55,
              channelId: 604,
              membershipId: 44,
              memberType: "agent",
              memberIdentity: "pi-crew-runner",
              profileIdentity: "pi-crew-runner",
              agentInstanceId: "pi-crew-runner-live",
              subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-live",
              subscriptionPurpose: "ordinary_channel",
              subscriptionStatus: "active",
              sessionOwnerId: "owner:den-k8plus:pi-crew-runner",
              sessionId: "sess-pi-crew-runner-live",
              createdAt: "2026-06-08T00:00:00Z",
              updatedAt: "2026-06-08T00:00:00Z",
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/api/channel-subscriptions?") && init?.method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({
          memberIdentity: "pi-crew-runner",
          subscriptions: [{
            subscriptionId: 55,
            channelId: 604,
            memberIdentity: "pi-crew-runner",
            profileIdentity: "pi-crew-runner",
            agentInstanceId: "pi-crew-runner-live",
            subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-live",
            subscriptionPurpose: "ordinary_channel",
            subscriptionStatus: "active",
          }],
        }), { status: 200 }));
      }
      if (url.includes("/api/channel-subscriptions/55/cursors") && init?.method === "GET") {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (url.includes("/api/direct-agent-events")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const conn = new DenHttpDirectAgentConnection(
      makeConfig(),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await conn.close();

    expect(calls.slice(0, 3).map((call) => call.url)).toEqual([
      "http://192.168.1.10:18081/api/channels/604/memberships",
      "http://192.168.1.10:18081/api/channels/604/subscriptions",
      "http://192.168.1.10:18081/api/channel-subscriptions?memberIdentity=pi-crew-runner&purpose=ordinary_channel&projectId=pi-crew&channelId=604",
    ]);
    expect(calls[3]?.url).toBe("http://192.168.1.10:18081/api/channel-subscriptions/55/cursors");
    expect(calls[4]?.url).toBe("http://192.168.1.10:18081/api/direct-agent-events?channelId=604&limit=1");
    expect(calls[0]?.body).toMatchObject({
      memberType: "agent",
      memberIdentity: "pi-crew-runner",
      membershipStatus: "active",
      wakePolicy: "all_messages_except_self",
      profileIdentity: "pi-crew-runner",
      memberRole: "runner",
    });
    expect(calls[0]?.body?.membershipPurpose).toBeUndefined();
    expect(calls[1]?.body).toMatchObject({
      memberType: "agent",
      memberIdentity: "pi-crew-runner",
      subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-live",
      subscriptionPurpose: "ordinary_channel",
      subscriptionStatus: "active",
      membershipId: 44,
      agentInstanceId: "pi-crew-runner-live",
      sessionOwnerId: "owner:den-k8plus:pi-crew-runner",
      sessionId: "sess-pi-crew-runner-live",
    });
  });

  it("fails closed before polling when required subscription identity is missing", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response("[]", { status: 200 })));
    const conn = new DenHttpDirectAgentConnection(
      makeConfig({ subscription: undefined }),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await expect(conn.open()).rejects.toBeInstanceOf(ConnectionError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed before polling when v8 membership route is unavailable without fallback", async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn((input: string | URL) => {
      const url = urlFromInput(input);
      calls.push(url);
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const conn = new DenHttpDirectAgentConnection(
      makeConfig(),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await expect(conn.open()).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toEqual(["http://192.168.1.10:18081/api/channels/604/memberships"]);
  });

  it("allows explicit legacy direct polling fallback when v8 registration is unavailable", async () => {
    const urls: string[] = [];
    const mockFetch = vi.fn((input: string | URL) => {
      const url = urlFromInput(input);
      urls.push(url);
      if (url.includes("/api/channels/604/memberships")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (url.includes("/api/direct-agent-events")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    const conn = new DenHttpDirectAgentConnection(
      makeConfig({ allowLegacyDirectPolling: true }),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await conn.close();

    expect(urls.some((url) => url.includes("/api/channels/604/memberships"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/direct-agent-events"))).toBe(true);
  });

  it("releases the runtime subscription on close without leaving membership", async () => {
    const calls: Array<{ readonly url: string; readonly body: Record<string, unknown> | null }> = [];
    const mockFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = urlFromInput(input);
      calls.push({ url, body: parseBody(init?.body) });
      if (url.includes("/api/direct-agent-events")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      if (url.includes("/api/channel-subscriptions?") && init?.method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({
          memberIdentity: "pi-crew-runner",
          subscriptions: [{
            subscriptionId: 55,
            channelId: 604,
            memberIdentity: "pi-crew-runner",
            subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-live",
            subscriptionStatus: "active",
          }],
        }), { status: 200 }));
      }
      if (url.includes("/api/channel-subscriptions/55/cursors") && init?.method === "GET") {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: 44, channelId: 604 }), { status: 200 }));
    });
    const conn = new DenHttpDirectAgentConnection(
      makeConfig(),
      logger,
      cursorStore,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    await conn.open();
    await conn.close();

    const subscriptionBodies = calls
      .filter((call) => call.url.includes("/api/channels/604/subscriptions"))
      .map((call) => call.body);
    expect(subscriptionBodies).toHaveLength(2);
    expect(subscriptionBodies[1]).toMatchObject({
      subscriptionIdentity: "pi-crew-runner:ordinary:sess-pi-crew-runner-live",
      subscriptionStatus: "degraded",
    });
    expect(calls.some((call) => call.url.includes("/memberships/pi-crew-runner/leave"))).toBe(false);
  });
});

function parseBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "string" || body.length === 0) return null;
  return JSON.parse(body) as Record<string, unknown>;
}
