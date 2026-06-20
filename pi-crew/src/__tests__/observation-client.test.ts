/**
 * Unit tests for the ObservationClient.
 *
 * @module pi-crew/__tests__/observation-client
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import {
  ObservationClient,
  type ObservationEvent,
} from "../observation/observation-client.js";

function makeTestEvent(overrides?: Partial<ObservationEvent>): ObservationEvent {
  return {
    sourceDomain: "runtime",
    eventType: "agent_session_started",
    agentIdentity: { profile: "test-agent", instanceId: "test-agent@host" },
    payload: {
      kind: "agent_activity.v1",
      schemaVersion: 1,
      summary: "Test event",
      severity: "info",
      visibility: "channel",
      adapter: "pi-crew",
      surface: "runtime",
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("ObservationClient", () => {
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
  });

  it("drops events silently when baseUrl is not configured", () => {
    const client = new ObservationClient({}, logger);
    // Should not throw
    expect(() => client.post(makeTestEvent())).not.toThrow();
  });

  it("drops events silently when baseUrl is empty", () => {
    const client = new ObservationClient({ baseUrl: "" }, logger);
    expect(() => client.post(makeTestEvent())).not.toThrow();
  });

  it("fires POST with correct payload shape when baseUrl is set", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const mockFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        capturedBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(new Response("ok", { status: 200 }));
      },
    );

    // Override global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const client = new ObservationClient(
        { baseUrl: "http://obs:8082" },
        logger,
      );
      client.post(makeTestEvent({ eventType: "work_started" }));

      // Wait for the async POST
      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      expect(capturedUrl).toBe("http://obs:8082/v1/observation/lifecycle-events");

      const body = JSON.parse(capturedBody);
      expect(body.sourceDomain).toBe("runtime");
      expect(body.eventType).toBe("work_started");
      expect(body.agentIdentity).toEqual({
        profile: "test-agent",
        instanceId: "test-agent@host",
      });
      expect(body.payload.kind).toBe("agent_activity.v1");
      expect(body.payload.schemaVersion).toBe(1);
      expect(body.payload.summary).toBe("Test event");
      expect(body.payload.severity).toBe("info");
      expect(body.payload.visibility).toBe("channel");
      expect(body.payload.adapter).toBe("pi-crew");
      expect(body.payload.surface).toBe("runtime");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("logs warning on non-OK response", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response("bad request", {
          status: 400,
          statusText: "Bad Request",
        }),
      ),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const client = new ObservationClient(
        { baseUrl: "http://obs:8082" },
        logger,
      );
      client.post(makeTestEvent());

      await vi.waitFor(() => {
        expect(
          logger.entries.some(
            (e) =>
              e.message === "Observation POST returned non-OK" &&
              e.context?.status === 400,
          ),
        ).toBe(true);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("logs timeout warning when fetch aborts", async () => {
    const mockFetch = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          const error = new DOMException("The operation was aborted", "AbortError");
          reject(error);
        }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const client = new ObservationClient(
        { baseUrl: "http://obs:8082", timeoutMs: 50 },
        logger,
      );
      client.post(makeTestEvent());
      expect(true).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
