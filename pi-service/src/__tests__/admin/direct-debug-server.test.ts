/** Tests for direct diagnostic session API routes. */
import { describe, expect, it } from "vitest";
import { AdminServer, type DirectDebugServicePort } from "../../admin/admin-server.js";
import type { DiagnosticsOverview } from "../../diagnostics/types.js";

const baseOverview: DiagnosticsOverview = {
  service: {
    status: "ok",
    version: "test",
    uptimeSeconds: 1,
    startedAt: "2026-06-13T00:00:00.000Z",
    drainMode: "inactive",
  },
  classification: { kind: "healthy", summary: "ok" },
  denCore: { status: "ok", lastOkAt: null },
  denChannels: { status: "ok", lastOkAt: null },
  mcp: { status: "ok", lastOkAt: null },
  runtimeDb: {
    status: "ok",
    path: "/tmp/runtime.db",
    walEnabled: true,
    tableCount: 1,
    schemaVersion: 1,
  },
  counts: {
    activeSessions: 1,
    workerSessions: 0,
    conversationalSessions: 1,
    activeAssignmentsLocal: 0,
    stuckWorkers: 0,
    checkpointWaiting: 0,
    degradedConversationalSessions: 0,
  },
  sessions: [
    {
      sessionId: "sess-prime-coder",
      profileId: "prime-coder",
      kind: "conversational",
      sessionState: "active",
      messageCount: 0,
      instanceId: "inst-1",
      channelBindings: [{ providerId: "den-channels", channelId: "642" }],
      channelBindingDetails: [{ providerId: "den-channels", channelId: "642" }],
      workerBinding: null,
      denAssignment: null,
      localLifecycleState: "unknown",
      lastActivityAt: "2026-06-13T00:00:00.000Z",
      lastGatewayEvent: null,
      contextPressure: null,
      drainState: "inactive",
      recentErrorCount: 0,
      presenceStatus: "active",
      classification: "healthy",
      evidenceRefs: [],
    },
  ],
  recentEvents: [
    {
      sequence: 1,
      observedAt: "2026-06-13T00:00:00.000Z",
      event: "turn.completed",
      payload: { sessionId: "sess-prime-coder" },
    },
  ],
};

describe("AdminServer direct debug routes", () => {
  it("serves unauthenticated debug session list and events without /admin auth", async () => {
    const service = new FakeDirectDebugService();
    const server = await startDebugServer(19510, service);
    try {
      const sessions = await json(
        await fetch(`http://${server.host}:${String(server.port)}/debug/sessions`),
      );
      const events = await json(
        await fetch(
          `http://${server.host}:${String(server.port)}/debug/sessions/sess-prime-coder/events`,
        ),
      );

      expect(sessions["sessions"]).toEqual(baseOverview.sessions);
      expect(events["events"]).toEqual(baseOverview.recentEvents);
    } finally {
      await server.stop();
    }
  });

  it("posts a diagnostic turn through the direct debug service", async () => {
    const service = new FakeDirectDebugService();
    const server = await startDebugServer(19511, service);
    try {
      const response = await fetch(
        `http://${server.host}:${String(server.port)}/debug/sessions/sess-prime-coder/turn`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "hello", metadata: { source: "test" } }),
        },
      );
      const body = await json(response);

      expect(response.status).toBe(200);
      expect(service.turnInputs).toEqual([
        { sessionId: "sess-prime-coder", message: "hello", emitDenVisibility: false },
      ]);
      expect(body).toMatchObject({
        sessionId: "sess-prime-coder",
        turnId: "turn-1",
        message: "debug response",
      });
      expect(body["diagnosticOnly"]).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

async function startDebugServer(
  port: number,
  directDebug: DirectDebugServicePort,
): Promise<AdminServer> {
  const server = new AdminServer({
    config: {
      enabled: true,
      host: "127.0.0.1",
      port,
      bearerToken: "admin-token",
      allowLanBind: false,
    },
    diagnostics: { projectOverview: () => Promise.resolve(baseOverview) },
    directDebug,
  });
  await server.start();
  return server;
}

class FakeDirectDebugService implements DirectDebugServicePort {
  readonly turnInputs: Array<{ sessionId: string; message: string; emitDenVisibility: boolean }> =
    [];

  async runTurn(input: {
    readonly sessionId: string;
    readonly message: string;
    readonly emitDenVisibility?: boolean;
  }) {
    this.turnInputs.push({
      sessionId: input.sessionId,
      message: input.message,
      emitDenVisibility: input.emitDenVisibility ?? false,
    });
    return {
      sessionId: input.sessionId,
      turnId: "turn-1",
      message: "debug response",
      toolCalls: [],
      delegationHandles: [],
      events: [],
      diagnostics: null,
      diagnosticOnly: true,
    };
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error("expected JSON object");
}
