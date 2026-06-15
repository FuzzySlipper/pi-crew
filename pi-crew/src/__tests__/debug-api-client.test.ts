/** Tests for the direct-debug API client and TUI state transitions. */
import { describe, expect, it } from "vitest";
import { DebugApiClient } from "../debug-api-client.js";
import { handleLine, type DebugTuiState } from "../debug-tui.js";

function sessionResponse() {
  return {
    sessions: [
      {
        sessionId: "sess-prime-coder",
        profileId: "prime-coder",
        instanceId: "inst-1",
        kind: "full",
        sessionState: "active",
        messageCount: 2,
        recentErrorCount: 0,
        presenceStatus: "active",
        classification: "healthy",
        lastActivityAt: "2026-06-13T00:00:00.000Z",
      },
    ],
  };
}

describe("DebugApiClient", () => {
  it("loads sessions, bounded context, events, tools, and turn responses", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = requestToString(url);
      calls.push({ url: requestUrl, init });
      if (requestUrl.endsWith("/debug/sessions")) {
        return response(sessionResponse());
      }
      if (requestUrl.includes("/context?limit=5")) {
        return response({
          sessionId: "sess-prime-coder",
          limit: 5,
          messageCount: 1,
          contextPressure: null,
          contextCompaction: null,
          messages: [
            {
              id: 1,
              role: "assistant",
              content: "history",
              toolName: null,
              tokenCount: 2,
              createdAt: "2026-06-13T00:00:00.000Z",
            },
          ],
        });
      }
      if (requestUrl.includes("/events?limit=3")) {
        return response({ events: [{ sequence: 1, event: "turn.completed" }] });
      }
      if (requestUrl.includes("/admin/diagnostics/tools/")) {
        return response({ inventories: [{ tools: ["get_task"] }] });
      }
      return response({
        sessionId: "sess-prime-coder",
        turnId: "turn-1",
        message: "assistant response",
        toolCalls: [],
        delegationHandles: [],
        events: [],
        diagnostics: null,
        diagnosticOnly: true,
      });
    }) as typeof fetch;
    const client = new DebugApiClient({
      baseUrl: "http://localhost:9237/",
      fetchImpl,
      adminBearerToken: "token",
    });

    await expect(client.listSessions()).resolves.toHaveLength(1);
    await expect(client.getContext("sess-prime-coder", 5)).resolves.toMatchObject({ messageCount: 1 });
    await expect(client.listEvents("sess-prime-coder", 3)).resolves.toHaveLength(1);
    await expect(client.listTools("sess-prime-coder")).resolves.toMatchObject({ inventories: [{ tools: ["get_task"] }] });
    await expect(client.postTurn("sess-prime-coder", "/status", "test")).resolves.toMatchObject({
      turnId: "turn-1",
      message: "assistant response",
    });
    expect(calls[3]?.init?.headers).toEqual({ Authorization: "Bearer token" });
    expect(calls[4]?.init?.method).toBe("POST");
  });
});

describe("debug TUI state", () => {
  it("keeps local commands local and forwards service slash commands as turns", async () => {
    const fetchImpl = ((url: string | URL | Request) => {
      const requestUrl = requestToString(url);
      if (requestUrl.endsWith("/debug/sessions")) return response(sessionResponse());
      if (requestUrl.includes("/events?limit=")) return response({ events: [] });
      if (requestUrl.includes("/context?limit=")) {
        return response({
          sessionId: "sess-prime-coder",
          limit: 30,
          messageCount: 1,
          contextPressure: null,
          contextCompaction: null,
          messages: [
            {
              id: 1,
              role: "user",
              content: "previous",
              toolName: null,
              tokenCount: null,
              createdAt: "2026-06-13T00:00:00.000Z",
            },
          ],
        });
      }
      return response({
        sessionId: "sess-prime-coder",
        turnId: "turn-2",
        message: "status from service",
        toolCalls: [],
        delegationHandles: [],
        events: [{ event: "turn.completed" }],
        diagnostics: null,
        diagnosticOnly: true,
      });
    }) as typeof fetch;
    const client = new DebugApiClient({ baseUrl: "http://localhost:9237", fetchImpl });
    const state: DebugTuiState = {
      selectedSessionId: "sess-prime-coder",
      sessions: [],
      transcript: [],
      events: [],
      status: "",
    };

    await handleLine(client, state, "/sessions");
    await handleLine(client, state, "/context");
    await handleLine(client, state, "/status");

    expect(state.sessions[0]?.sessionId).toBe("sess-prime-coder");
    expect(state.transcript.map((line) => line.text)).toEqual([
      "previous",
      "/status",
      "status from service",
    ]);
  });
});

function response(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function requestToString(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.toString();
  return url.url;
}
