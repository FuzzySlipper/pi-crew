/**
 * Lifecycle telemetry regressions for the HTTP direct-agent connection.
 *
 * @module pi-channels/__tests__/connection-http-lifecycle
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import { FakeLogger } from "@pi-crew/core";

import { DenHttpDirectAgentConnection } from "./connection-http.js";
import type { CursorStore, DenHttpConnectionConfig } from "./connection-types.js";

function makeConfig(): DenHttpConnectionConfig {
  return {
    baseUrl: "http://192.168.1.10:18081",
    projectId: "pi-crew",
    memberIdentity: "pi-crew-gateway",
    token: "test-token",
    pollIntervalMs: 5000,
    pollLimit: 1,
    allowLegacyDirectPolling: true,
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

describe("DenHttpDirectAgentConnection lifecycle telemetry", () => {
  let logger: FakeLogger;
  let cursorStore: InMemoryCursorStore;

  beforeEach(() => {
    logger = new FakeLogger();
    cursorStore = new InMemoryCursorStore();
  });

  it("emits turn heartbeat telemetry with correlation and without heartbeat channel messages", async () => {
    const lifecycleBodies: string[] = [];
    const gatewayBodies: string[] = [];
    const mockFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const urlStr = urlFromInput(input);
      if (urlStr.includes("/api/direct-agent-events")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: 4040,
                channelId: 642,
                memberIdentity: "pi-crew-gateway",
                sourceProjectId: "pi-crew",
                targetProjectId: "pi-crew",
                targetTaskId: 2040,
                assignmentId: "assignment-2040",
                workerRunId: "piw_2040_lifecycle",
                workerRole: "runtime-smoke",
                agentInstanceId: "pi-crew-gateway-live",
                profileIdentity: "pi-crew-gateway",
                poolMemberId: "pool-runtime-01",
                body: "return NON_ECHO_RUNTIME_OK for 19+23",
                createdAt: "2026-06-06T12:40:00Z",
              },
            ]),
            { status: 200 },
          ),
        );
      }
      if (urlStr.includes("/api/agent-work/lifecycle-events")) {
        if (typeof init?.body === "string") lifecycleBodies.push(init.body);
        return Promise.resolve(new Response("ok", { status: 201 }));
      }
      if (urlStr.includes("/api/gateway/system-messages")) {
        if (typeof init?.body === "string") gatewayBodies.push(init.body);
        return Promise.resolve(new Response("ok", { status: 200 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const conn = new DenHttpDirectAgentConnection(makeConfig(), logger, cursorStore, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await conn.close();

    const payloads = lifecycleBodies.map((body) => JSON.parse(body) as Record<string, unknown>);
    expect(payloads.map((payload) => payload.eventType)).toEqual([
      "runtime_received",
      "request_claimed",
      "agent_turn_started",
      "heartbeat",
      "completed",
    ]);
    expect(payloads.every((payload) => payload.projectId === "pi-crew")).toBe(true);
    expect(payloads.every((payload) => payload.taskId === 2040)).toBe(true);
    expect(payloads.every((payload) => payload.assignmentId === "assignment-2040")).toBe(true);
    expect(payloads.every((payload) => payload.workerRunId === "piw_2040_lifecycle")).toBe(true);
    expect(payloads.every((payload) => payload.agentInstanceId === "pi-crew-gateway-live")).toBe(
      true,
    );

    const activePayloads = payloads.filter((payload) => payload.eventType !== "completed");
    expect(activePayloads.every((payload) => typeof payload.stalenessDeadline === "string")).toBe(
      true,
    );
    expect(payloads[payloads.length - 1]?.stalenessDeadline).toBeUndefined();
    expect(gatewayBodies).toHaveLength(0);
  });

  it("logs gateway failure diagnostics when final message delivery returns non-OK", async () => {
    const mockFetch = vi.fn((input: string | URL) => {
      const urlStr = urlFromInput(input);
      if (urlStr.includes("/api/gateway/system-messages")) {
        return Promise.resolve(new Response("constraint failed", { status: 500 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    const conn = new DenHttpDirectAgentConnection(makeConfig(), logger, cursorStore, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await conn.sendMessage("642", {
      content: { kind: "text", text: "final status" },
      metadata: { senderIdentity: "pi-orchestrator" },
    });

    expect(logger.entries.map((entry) => entry.message)).toContain(
      "Gateway system-message POST returned non-OK",
    );
    const warning = logger.entries.find(
      (entry) => entry.message === "Gateway system-message POST returned non-OK",
    );
    expect(warning?.context).toMatchObject({
      channelId: 642,
      senderIdentity: "pi-orchestrator",
      status: 500,
      responseBody: "constraint failed",
      bodyLength: "final status".length,
    });
    expect(typeof warning?.context?.sourceId).toBe("string");
  });

  it("fails closed before delivery when lifecycle telemetry cannot be recorded", async () => {
    const gatewayBodies: string[] = [];
    const errors: Error[] = [];
    const mockFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const urlStr = urlFromInput(input);
      if (urlStr.includes("/api/direct-agent-events")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: 4041,
                channelId: 604,
                memberIdentity: "pi-crew-gateway",
                targetProjectId: "pi-crew",
                targetTaskId: 2040,
                body: "must not be delivered without telemetry",
              },
            ]),
            { status: 200 },
          ),
        );
      }
      if (urlStr.includes("/api/agent-work/lifecycle-events")) {
        return Promise.resolve(new Response("schema drift", { status: 500 }));
      }
      if (urlStr.includes("/api/channel-activity-events")) {
        return Promise.resolve(new Response("legacy failed", { status: 500 }));
      }
      if (urlStr.includes("/api/gateway/system-messages")) {
        if (typeof init?.body === "string") gatewayBodies.push(init.body);
        return Promise.resolve(new Response("ok", { status: 200 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const conn = new DenHttpDirectAgentConnection(makeConfig(), logger, cursorStore, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    conn.on("error", (error) => {
      errors.push(error);
    });

    await conn.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await conn.close();

    expect(gatewayBodies).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Lifecycle telemetry");
    expect(await cursorStore.read("den_channels_cursor")).toBeNull();
  });
});
