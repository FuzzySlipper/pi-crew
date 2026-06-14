/** Tests for direct diagnostic session service. */
import { describe, expect, it } from "vitest";
import type { ChannelProvider } from "@pi-crew/core";
import { DirectDebugSessionService } from "../../admin/direct-debug-session-service.js";
import type { DiagnosticsOverview } from "../../diagnostics/types.js";
import type { SessionManager } from "../../sessions/session-manager.js";
import type { SessionRecord, SessionConfig } from "../../sessions/types.js";

const conversation: SessionRecord = {
  id: "sess-prime-coder",
  profileId: "prime-coder",
  instanceId: "inst-1",
  kind: "conversational",
  delegation: null,
  delegationSpawnRequest: null,
  createdAt: "2026-06-13T00:00:00.000Z",
  lastActiveAt: "2026-06-13T00:00:00.000Z",
  state: "active",
  messageCount: 0,
  channelBindings: [{ providerId: "den-channels", channelId: "642" }],
  workerBinding: null,
};

const worker: SessionRecord = {
  ...conversation,
  id: "worker-session",
  kind: "worker",
  channelBindings: [],
  workerBinding: {
    assignmentId: "a1",
    runId: "r1",
    taskId: "2410",
    projectId: "pi-crew",
    role: "coder",
  },
};

describe("DirectDebugSessionService", () => {
  it("routes a diagnostic turn through SessionManager and captures the response", async () => {
    const manager = new FakeSessionManager(conversation);
    const service = new DirectDebugSessionService({
      sessionManager: manager,
      diagnostics: diagnostics(),
      idFactory: () => "turn-debug-1",
    });

    const result = await service.runTurn({
      sessionId: "sess-prime-coder",
      message: "hello",
      contextDiagnostics: true,
    });

    expect(manager.routedMessages).toHaveLength(1);
    expect(manager.routedMessages[0]?.message).toMatchObject({
      id: "turn-debug-1",
      channelId: "642",
      content: { kind: "text", text: "hello" },
      metadata: { source: "direct-debug-cli", diagnosticOnly: true, emitDenVisibility: false },
    });
    expect(result).toMatchObject({
      sessionId: "sess-prime-coder",
      turnId: "turn-debug-1",
      message: "captured response",
      diagnosticOnly: true,
    });
    expect(result.diagnostics).toMatchObject({
      sessionId: "sess-prime-coder",
      turnId: "turn-debug-1",
    });
  });

  it("handles slash commands without routing to the LLM path", async () => {
    const manager = new FakeSessionManager(conversation);
    const service = new DirectDebugSessionService({
      sessionManager: manager,
      diagnostics: diagnostics(),
      idFactory: () => "turn-debug-command",
    });

    const result = await service.runTurn({
      sessionId: "sess-prime-coder",
      message: "/help",
      contextDiagnostics: true,
    });

    expect(manager.routedMessages).toHaveLength(0);
    expect(result.message).toContain("Control-plane commands");
    expect(result.message).toContain("/status");
    expect(result.diagnostics).toEqual({ commandSurface: "control-plane" });
  });

  it("rejects worker sessions and sessions without a channel binding", async () => {
    const workerService = new DirectDebugSessionService({
      sessionManager: new FakeSessionManager(worker),
      diagnostics: diagnostics(),
      idFactory: () => "turn-debug-1",
    });
    const unboundService = new DirectDebugSessionService({
      sessionManager: new FakeSessionManager({ ...conversation, channelBindings: [] }),
      diagnostics: diagnostics(),
      idFactory: () => "turn-debug-1",
    });

    await expect(
      workerService.runTurn({ sessionId: "worker-session", message: "hello" }),
    ).rejects.toThrow(/conversational/);
    await expect(
      unboundService.runTurn({ sessionId: "sess-prime-coder", message: "hello" }),
    ).rejects.toThrow(/channel binding/);
  });
});

class FakeSessionManager implements SessionManager {
  readonly routedMessages: Array<{
    provider: ChannelProvider;
    message: Parameters<SessionManager["routeMessage"]>[1];
  }> = [];

  constructor(private readonly session: SessionRecord | null) {}

  create(_config: SessionConfig): Promise<SessionRecord> {
    throw new Error("not implemented");
  }

  get(sessionId: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.session?.id === sessionId ? this.session : null);
  }

  findByChannel(_channelId: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.session);
  }

  bindChannel(_sessionId: string, _channelId: string): Promise<void> {
    return Promise.resolve();
  }

  unbindChannel(_sessionId: string, _channelId: string): Promise<void> {
    return Promise.resolve();
  }

  async routeMessage(
    provider: ChannelProvider,
    message: Parameters<SessionManager["routeMessage"]>[1],
  ): Promise<void> {
    this.routedMessages.push({ provider, message });
    await provider.sendMessage(message.channelId, { kind: "text", text: "captured response" });
  }

  async routeDiagnosticMessage(
    sessionId: string,
    provider: ChannelProvider,
    message: Parameters<SessionManager["routeMessage"]>[1],
  ): Promise<void> {
    if (this.session?.id !== sessionId) throw new Error("wrong session");
    await this.routeMessage(provider, message);
  }

  archive(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  evictIdleSessions(): Promise<number> {
    return Promise.resolve(0);
  }
}

function diagnostics(): { projectOverview(): Promise<DiagnosticsOverview> } {
  return {
    projectOverview: () =>
      Promise.resolve({
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
        sessions: [],
        recentEvents: [
          {
            sequence: 1,
            observedAt: "2026-06-13T00:00:00.000Z",
            event: "tool.called",
            payload: { sessionId: "sess-prime-coder" },
          },
        ],
      }),
  };
}
