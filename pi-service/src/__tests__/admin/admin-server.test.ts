/** Tests for read-only local admin diagnostics HTTP API. */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../config.js";
import { AdminServer } from "../../admin/admin-server.js";
import type { DiagnosticsOverview } from "../../diagnostics/types.js";

const token = ["test", "admin", "token"].join("-");

describe("admin diagnostics config", () => {
  it("fails closed when admin is enabled without a bearer token", () => {
    expect(() =>
      loadConfig({
        den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false },
        admin: { enabled: true },
      }),
    ).toThrow("admin.bearerToken");
  });

  it("requires explicit LAN opt-in for non-localhost admin bind", () => {
    expect(() =>
      loadConfig({
        den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false },
        admin: {
          enabled: true,
          host: "0.0.0.0",
          bearerToken: token,
          allowLanBind: false,
        },
      }),
    ).toThrow("admin.allowLanBind");
  });
});

describe("AdminServer", () => {
  it("serves diagnostics overview with bearer auth and stable schema", async () => {
    const server = await startServer(19360, healthyOverview());
    try {
      const response = await adminFetch(server, "/admin/diagnostics/overview", token);
      const body = await responseJson(response);

      expect(response.status).toBe(200);
      expect(Object.keys(body)).toEqual([
        "service",
        "classification",
        "denCore",
        "denChannels",
        "mcp",
        "runtimeDb",
        "counts",
        "sessions",
        "recentEvents",
      ]);
      expect(readPath(body, ["classification", "kind"])).toBe("healthy");
      expect(readPath(body, ["sessions", "0", "workerBinding", "assignmentId"])).toBe(
        "assignment-1",
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects missing or wrong bearer tokens without leaking the configured token", async () => {
    const server = await startServer(19361, healthyOverview());
    try {
      const response = await adminFetch(server, "/admin/diagnostics/overview", "wrong-token");
      const text = await response.text();

      expect(response.status).toBe(401);
      expect(text).toContain("unauthorized");
      expect(text).not.toContain(token);
      expect(text).not.toContain("wrong-token");
    } finally {
      await server.stop();
    }
  });

  it("serves Prometheus metrics with bearer auth", async () => {
    const metrics = [
      "# HELP pi_crew_runtime_uptime_seconds Runtime process uptime in seconds.",
      "# TYPE pi_crew_runtime_uptime_seconds gauge",
      "pi_crew_runtime_uptime_seconds 12",
      "",
    ].join("\n");
    const server = await startServer(19365, healthyOverview(), metrics);
    try {
      const response = await adminFetch(server, "/admin/metrics", token);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(text).toContain("# HELP pi_crew_runtime_uptime_seconds");
      expect(text).not.toContain("assignment-1");
    } finally {
      await server.stop();
    }
  });

  it("redacts secrets in diagnostic event payloads", async () => {
    const overview = healthyOverview({
      recentEvents: [
        {
          sequence: 1,
          observedAt: "2026-06-08T04:40:00.000Z",
          event: "tool.called",
          payload: {
            params: {
              Authorization: "Bearer super-secret-value",
              nested: { apiKey: "sk-live-secret-value" },
              safe: "visible",
            },
          },
        },
      ],
    });
    const server = await startServer(19362, overview);
    try {
      const response = await adminFetch(server, "/admin/diagnostics/events?limit=1", token);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain("[REDACTED]");
      expect(text).toContain("visible");
      expect(text).not.toContain("Bearer super-secret");
    } finally {
      await server.stop();
    }
  });

  it("preserves Den-unavailable classification in connectivity output", async () => {
    const server = await startServer(
      19363,
      healthyOverview({
        classification: {
          kind: "den_core_unreachable",
          summary: "Den Core is unreachable; Den remains authoritative.",
        },
        denCore: { status: "unreachable", lastOkAt: null },
      }),
    );
    try {
      const response = await adminFetch(server, "/admin/diagnostics/connectivity", token);
      const body = await responseJson(response);

      expect(response.status).toBe(200);
      expect(readPath(body, ["classification", "kind"])).toBe("den_core_unreachable");
      expect(readPath(body, ["denCore", "status"])).toBe("unreachable");
    } finally {
      await server.stop();
    }
  });

  it("keeps remediation controls absent from the read-only task scope", async () => {
    const server = await startServer(19364, healthyOverview());
    try {
      const response = await adminFetch(server, "/admin/control/drain", token, { method: "POST" });
      const body = await responseJson(response);

      expect(response.status).toBe(404);
      expect(readPath(body, ["error"])).toBe("not_found");
    } finally {
      await server.stop();
    }
  });
});

async function startServer(
  port: number,
  overview: DiagnosticsOverview,
  metrics: string | null = null,
): Promise<AdminServer> {
  const server = new AdminServer({
    config: {
      enabled: true,
      host: "127.0.0.1",
      port,
      bearerToken: token,
      allowLanBind: false,
    },
    diagnostics: { projectOverview: () => Promise.resolve(overview) },
    metrics: metrics === null ? undefined : { projectPrometheus: () => Promise.resolve(metrics) },
  });
  await server.start();
  return server;
}

function adminFetch(
  server: AdminServer,
  path: string,
  bearerToken: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://${server.host}:${String(server.port)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error("expected JSON object response");
}

function readPath(value: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function healthyOverview(overrides: Partial<DiagnosticsOverview> = {}): DiagnosticsOverview {
  return {
    service: {
      status: "ok",
      version: "test",
      uptimeSeconds: 12,
      startedAt: "2026-06-08T04:40:00.000Z",
      drainMode: "inactive",
    },
    classification: { kind: "healthy", summary: "ok" },
    denCore: { status: "ok", lastOkAt: "2026-06-08T04:40:00.000Z" },
    denChannels: { status: "ok", lastOkAt: "2026-06-08T04:40:00.000Z" },
    mcp: { status: "ok", lastOkAt: "2026-06-08T04:40:00.000Z" },
    runtimeDb: {
      status: "ok",
      path: "/tmp/pi-crew.sqlite",
      walEnabled: true,
      tableCount: 4,
      schemaVersion: 1,
    },
    counts: {
      activeSessions: 1,
      workerSessions: 1,
      conversationalSessions: 0,
      activeAssignmentsLocal: 1,
      stuckWorkers: 0,
      checkpointWaiting: 0,
      degradedConversationalSessions: 0,
    },
    sessions: [
      {
        sessionId: "session-1",
        profileId: "spawned-coder",
        instanceId: "instance-1",
        kind: "worker",
        sessionState: "active",
        messageCount: 2,
        channelBindings: [],
        channelBindingDetails: [],
        workerBinding: {
          assignmentId: "assignment-1",
          runId: "run-1",
          taskId: "2117",
          projectId: "pi-crew",
          role: "coder",
        },
        denAssignment: { assignmentId: "assignment-1", isActive: true },
        localLifecycleState: "turn.started",
        lastActivityAt: "2026-06-08T04:40:00.000Z",
        lastGatewayEvent: "turn.started",
        contextPressure: null,
        drainState: "inactive",
        recentErrorCount: 0,
        presenceStatus: "active",
        classification: "healthy",
        evidenceRefs: [],
      },
    ],
    recentEvents: [],
    ...overrides,
  };
}
