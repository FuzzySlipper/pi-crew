import { describe, expect, it, vi } from "vitest";

import { FakeLogger } from "@pi-crew/core";

import { DenHttpDirectAgentConnection } from "./connection-http.js";
import type { CursorStore } from "./connection-types.js";

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

describe("DenHttpDirectAgentConnection configured member identity", () => {
  it("uses the accepted target member identity for lifecycle and replies", async () => {
    const postedLifecycleBodies: string[] = [];
    const postedGatewayBodies: string[] = [];
    const responsePosts: Promise<unknown>[] = [];
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
                  memberIdentity: "pi-crew-runner",
                  targetMemberIdentity: "pi-crew-planner",
                  sourceKind: "wake_event",
                  sourceProjectId: "pi-crew",
                  targetProjectId: "pi-crew",
                  body: "hello planner",
                  createdAt: "2026-06-10T00:00:00Z",
                },
              ],
              nextAfterId: null,
              hasMore: false,
            }),
            { status: 200 },
          ),
        );
      }
      if (urlStr.includes("/api/agent-work/lifecycle-events")) {
        postedLifecycleBodies.push(bodyText(init));
      }
      if (urlStr.includes("/api/gateway/system-messages")) {
        postedGatewayBodies.push(bodyText(init));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const conn = new DenHttpDirectAgentConnection(
      {
        baseUrl: "http://192.168.1.10:18081",
        projectId: "pi-crew",
        memberIdentity: "pi-crew-runner",
        memberIdentities: ["pi-crew-planner"],
        token: "test-token",
        pollIntervalMs: 5000,
        pollLimit: 1,
        allowLegacyDirectPolling: true,
      },
      new FakeLogger(),
      new InMemoryCursorStore(),
      { fetchFn: mockFetch as unknown as typeof fetch },
    );
    conn.on("message", (message) => {
      responsePosts.push(
        conn.sendMessage(message.channelId, {
          content: {
            kind: "text",
            text: "planner response",
          },
          metadata: { senderIdentity: "pi-crew-planner" },
        }),
      );
    });

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await Promise.all(responsePosts);
    await conn.close();

    expect(postedLifecycleBodies.length).toBeGreaterThan(0);
    expect(
      postedLifecycleBodies.map((body) => JSON.parse(body) as { agentIdentity: string }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentIdentity: "pi-crew-planner" })]),
    );
    expect(postedGatewayBodies).toHaveLength(1);
    expect(JSON.parse(postedGatewayBodies[0] ?? "{}")).toEqual(
      expect.objectContaining({ senderIdentity: "pi-crew-planner" }),
    );
  });
});

function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}
