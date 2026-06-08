/** Den HTTP direct-agent ingress metadata tests. */

import { describe, expect, it, vi } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { DenHttpDirectAgentConnection } from "./connection-http.js";
import type { CursorStore } from "./connection-types.js";

class MemoryCursorStore implements CursorStore {
  #values = new Map<string, string>();

  read(key: string): Promise<string | null> {
    return Promise.resolve(this.#values.get(key) ?? null);
  }

  write(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("DenHttpDirectAgentConnection ingress intent metadata", () => {
  it("preserves steer intent metadata from direct-agent readback", async () => {
    const seen: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((url: string | URL) => {
      const path = url.toString();
      seen.push({ path });
      if (path.includes("/api/subscriptions")) {
        return response({ success: true, subscription: { id: "sub-1" } });
      }
      if (path.includes("/api/direct-agent-events")) {
        return response({
          items: [{
            id: 101,
            channelId: 604,
            messageKind: "human_text",
            senderType: "user",
            senderIdentity: "planner",
            memberIdentity: "pi-crew-runner",
            sourceKind: "gateway_delivery",
            body: "adjust course",
            assignmentId: "959",
            workerRunId: "piw_run",
            intent: "steer",
            createdAt: "2026-06-08T12:00:00Z",
          }],
          nextAfterId: 101,
          hasMore: false,
        });
      }
      return response({ items: [], nextAfterId: null, hasMore: false });
    });

    const connection = new DenHttpDirectAgentConnection(
      {
        baseUrl: "http://den-channels.test",
        projectId: "pi-crew",
        memberIdentity: "pi-crew-runner",
        token: "test-token",
        pollIntervalMs: 5000,
        allowLegacyDirectPolling: true,
      },
      new FakeLogger(),
      new MemoryCursorStore(),
      { fetchFn: fetchMock as unknown as typeof fetch },
    );

    const messages: Array<Record<string, unknown>> = [];
    connection.on("message", (message) => {
      messages.push(message.metadata ?? {});
    });

    await connection.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await connection.close();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      intent: "steer",
      assignmentId: "959",
      workerRunId: "piw_run",
      eventKind: "direct-agent-event",
    });
  });
});
