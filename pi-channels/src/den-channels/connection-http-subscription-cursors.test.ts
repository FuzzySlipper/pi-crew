/** Tests for subscription-owned cursor consumption in Den HTTP direct-agent polling. */
import { describe, expect, it, beforeEach, vi } from "vitest";

import { FakeLogger } from "@pi-crew/core";

import { DenHttpDirectAgentConnection } from "./connection-http.js";
import type { CursorStore, DenHttpConnectionConfig, DenInboundMessage } from "./connection-types.js";

function makeConfig(): DenHttpConnectionConfig {
  return {
    baseUrl: "http://192.168.1.10:18081",
    projectId: "pi-crew",
    memberIdentity: "pi-crew-runner",
    token: "test-token",
    pollIntervalMs: 5_000,
    pollLimit: 2,
    subscription: {
      channelId: "642",
      profileIdentity: "pi-crew-runner",
      memberRole: "runner",
      agentInstanceId: "inst-live-2",
      sessionOwnerId: "owner:den-k8plus:pi-crew-runner",
      sessionId: "sess-live",
      subscriptionIdentity: "pi-crew-runner:ordinary:sess-live",
    },
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

function parseBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "string" || body.length === 0) return null;
  return JSON.parse(body) as Record<string, unknown>;
}

function subscriptionResponse() {
  return {
    memberIdentity: "pi-crew-runner",
    subscriptions: [
      {
        subscriptionId: 55,
        channelId: 642,
        memberIdentity: "pi-crew-runner",
        profileIdentity: "pi-crew-runner",
        agentInstanceId: "inst-live-2",
        subscriptionIdentity: "pi-crew-runner:ordinary:sess-live",
        subscriptionPurpose: "ordinary_channel",
        subscriptionStatus: "active",
        targetProjectId: "pi-crew",
        targetTaskId: 2113,
        assignmentId: "assignment-2113",
        workerRunId: "piw_2113_cursor",
        workerRole: "runner",
      },
    ],
  };
}

describe("DenHttpDirectAgentConnection subscription cursors", () => {
  let logger: FakeLogger;
  let cursorStore: InMemoryCursorStore;

  beforeEach(() => {
    logger = new FakeLogger();
    cursorStore = new InMemoryCursorStore();
  });

  it("uses the subscription cursor instead of stale local cursor on restart", async () => {
    await cursorStore.write("den_channels_cursor", "9999");
    const pollUrls: string[] = [];
    const mockFetch = vi.fn((input: string | URL) => {
      const url = urlFromInput(input);
      if (url.includes("/api/channel-subscriptions?")) {
        return Promise.resolve(new Response(JSON.stringify(subscriptionResponse()), { status: 200 }));
      }
      if (url.endsWith("/api/channel-subscriptions/55/cursors")) {
        return Promise.resolve(new Response(JSON.stringify([{ streamKind: "subscription_messages", lastSeenId: 41 }]), { status: 200 }));
      }
      if (url.includes("/api/direct-agent-events")) {
        pollUrls.push(url);
        return Promise.resolve(new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: 44, channelId: 642 }), { status: 200 }));
    });
    const conn = new DenHttpDirectAgentConnection(makeConfig(), logger, cursorStore, { fetchFn: mockFetch as unknown as typeof fetch });

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await conn.close();

    expect(pollUrls[0]).toBe("http://192.168.1.10:18081/api/direct-agent-events?channelId=642&limit=2&afterId=41");
  });

  it("advances Den subscription cursor and local cache after every observed row", async () => {
    const cursorBodies: Record<string, unknown>[] = [];
    const mockFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = urlFromInput(input);
      if (url.includes("/api/channel-subscriptions?")) {
        return Promise.resolve(new Response(JSON.stringify(subscriptionResponse()), { status: 200 }));
      }
      if (url.endsWith("/api/channel-subscriptions/55/cursors")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (url.includes("/api/channel-subscriptions/55/cursors/subscription_messages")) {
        const body = parseBody(init?.body);
        if (body) cursorBodies.push(body);
        return Promise.resolve(new Response(JSON.stringify({ id: 1, subscriptionId: 55, streamKind: "subscription_messages", lastSeenId: body?.lastSeenId }), { status: 200 }));
      }
      if (url.includes("/api/direct-agent-events")) {
        return Promise.resolve(new Response(JSON.stringify({ items: [
          { id: 3001, channelId: 642, memberIdentity: "pi-crew-runner", sourceKind: "wake_event", body: "work", createdAt: "2026-06-08T00:00:00Z" },
          { id: 3002, channelId: 642, sourceKind: "gateway_delivery", body: "echo", createdAt: "2026-06-08T00:00:01Z" },
        ], hasMore: false }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: 44, channelId: 642 }), { status: 200 }));
    });
    const conn = new DenHttpDirectAgentConnection(makeConfig(), logger, cursorStore, { fetchFn: mockFetch as unknown as typeof fetch });

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await conn.close();

    expect(cursorBodies.map((body) => body.lastSeenId)).toEqual([3001, 3002]);
    expect(cursorBodies[0]?.cursorJson).toContain("pi-crew-runner:ordinary:sess-live");
    expect(await cursorStore.read("den_channels_cursor")).toBe("3002");
  });

  it("propagates subscription and work metadata without echoing gateway delivery messages", async () => {
    const gatewayBodies: string[] = [];
    const received: DenInboundMessage[] = [];
    const mockFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = urlFromInput(input);
      if (url.includes("/api/channel-subscriptions?")) {
        return Promise.resolve(new Response(JSON.stringify(subscriptionResponse()), { status: 200 }));
      }
      if (url.endsWith("/api/channel-subscriptions/55/cursors")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (url.includes("/api/direct-agent-events")) {
        return Promise.resolve(new Response(JSON.stringify({ items: [{
          id: 3003,
          channelId: 642,
          memberIdentity: "pi-crew-runner",
          sourceKind: "wake_event",
          sourceProjectId: "pi-crew",
          targetProjectId: "pi-crew",
          targetTaskId: 2113,
          assignmentId: "assignment-2113",
          workerRunId: "piw_2113_cursor",
          workerRole: "runner",
          profileIdentity: "pi-crew-runner",
          agentInstanceId: "inst-live-2",
          sessionOwnerId: "owner:den-k8plus:pi-crew-runner",
          sessionId: "sess-live",
          deliveryStatus: "pending_subscription",
          claimStatus: "pending_claim",
          completionStatus: "running",
          body: "route via subscription cursor",
        }], hasMore: false }), { status: 200 }));
      }
      if (url.includes("/api/gateway/system-messages")) {
        if (typeof init?.body === "string") gatewayBodies.push(init.body);
      }
      return Promise.resolve(new Response(JSON.stringify({ id: 44, channelId: 642 }), { status: 200 }));
    });
    const conn = new DenHttpDirectAgentConnection(makeConfig(), logger, cursorStore, { fetchFn: mockFetch as unknown as typeof fetch });
    conn.on("message", (message) => received.push(message));

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await conn.close();

    expect(gatewayBodies).toHaveLength(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.metadata).toMatchObject({
      eventId: 3003,
      subscriptionId: "55",
      membershipId: "44",
      memberIdentity: "pi-crew-runner",
      profileIdentity: "pi-crew-runner",
      agentInstanceId: "inst-live-2",
      sessionOwnerId: "owner:den-k8plus:pi-crew-runner",
      sessionId: "sess-live",
      subscriptionIdentity: "pi-crew-runner:ordinary:sess-live",
      subscriptionStatus: "active",
      deliveryStatus: "pending_subscription",
      claimStatus: "pending_claim",
      completionStatus: "running",
      targetTaskId: 2113,
      assignmentId: "assignment-2113",
      workerRunId: "piw_2113_cursor",
    });
  });
});
