/** Tests for conversational slash command routing. */
import { describe, expect, it } from "vitest";
import { createSlashCommandRouter } from "../../admin/slash-command-router.js";
import type { DiagnosticsOverview, DiagnosticSessionProjection } from "../../diagnostics/types.js";
import type { SessionRecord } from "../../sessions/types.js";

const session: SessionRecord = {
  id: "sess-prime-coder",
  profileId: "prime-coder",
  instanceId: "inst-1",
  kind: "conversational",
  delegation: null,
  delegationSpawnRequest: null,
  createdAt: "2026-06-13T00:00:00.000Z",
  lastActiveAt: "2026-06-13T00:00:00.000Z",
  state: "active",
  messageCount: 3,
  channelBindings: [{ providerId: "den-channels", channelId: "642" }],
  workerBinding: null,
};

describe("SlashCommandRouter", () => {
  it("intercepts help and status commands before model routing", async () => {
    const router = createSlashCommandRouter({ diagnostics: diagnostics() });

    const help = await router.tryHandle({ session, input: "/help" });
    const status = await router.tryHandle({ session, input: "/status" });
    const normal = await router.tryHandle({ session, input: "hello model" });

    expect(help.handled).toBe(true);
    expect(help.message).toContain("/new");
    expect(status.handled).toBe(true);
    expect(status.message).toContain("sess-prime-coder");
    expect(status.message).toContain("prime-coder");
    expect(normal.handled).toBe(false);
  });

  it("rejects worker sessions and returns precise reload limitation", async () => {
    const router = createSlashCommandRouter({ diagnostics: diagnostics() });
    const worker = { ...session, kind: "worker" as const, channelBindings: [] };

    const workerResult = await router.tryHandle({ session: worker, input: "/status" });
    const reload = await router.tryHandle({ session, input: "/reload-mcp" });

    expect(workerResult).toMatchObject({ handled: true, command: "status", ok: false });
    expect(workerResult.message).toContain("conversational sessions");
    expect(reload).toMatchObject({ handled: true, command: "reload-mcp", ok: false });
    expect(reload.message).toContain("not yet available");
  });
});

function diagnostics(): { projectOverview(): Promise<DiagnosticsOverview> } {
  return { projectOverview: () => Promise.resolve(overview()) };
}

function overview(): DiagnosticsOverview {
  const projection: DiagnosticSessionProjection = {
    sessionId: "sess-prime-coder",
    profileId: "prime-coder",
    instanceId: "inst-1",
    kind: "conversational",
    sessionState: "active",
    messageCount: 3,
    channelBindings: session.channelBindings,
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
  };
  return {
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
    sessions: [projection],
    recentEvents: [],
  };
}
