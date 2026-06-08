/** Tests for runtime-local diagnostics projection layer. */
import { FakeEventBus } from "@pi-crew/core";
import type { GatewayEvent } from "@pi-crew/core";
import { describe, expect, it } from "vitest";

import type { DenAssignmentStatus } from "../../persistence/types.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import type { SessionRecord } from "../../sessions/types.js";
import { DiagnosticsService } from "../../diagnostics/diagnostics-service.js";
import { InMemoryDiagnosticEventJournal } from "../../diagnostics/event-journal.js";
import type { DiagnosticStatusReader, RuntimeHealthReader } from "../../diagnostics/types.js";

const now = "2026-06-08T04:30:00.000Z";

class StaticStatusReader implements DiagnosticStatusReader {
  constructor(private readonly status: "ok" | "degraded" | "unreachable") {}

  readStatus() {
    return Promise.resolve({ status: this.status, lastOkAt: this.status === "ok" ? now : null });
  }
}

class StaticRuntimeHealthReader implements RuntimeHealthReader {
  constructor(private readonly failed = false) {}

  health() {
    if (this.failed) {
      return { status: "failed" as const, error: "runtime db closed" };
    }
    return {
      status: "ok" as const,
      path: "/tmp/pi-crew.sqlite",
      walEnabled: true,
      tableCount: 4,
      schemaVersion: 1,
    };
  }
}

class StaticDenAssignmentReader {
  constructor(private readonly statuses: DenAssignmentStatus[]) {}

  checkAssignments(ids: string[]) {
    return Promise.resolve(this.statuses.filter((status) => ids.includes(status.assignmentId)));
  }
}

describe("DiagnosticsService", () => {
  it("projects worker sessions with Den assignment/run binding readback", async () => {
    const eventBus = new FakeEventBus();
    const journal = new InMemoryDiagnosticEventJournal(eventBus, { clock: () => now });
    const store = new InMemorySessionStore();
    await store.save(workerSession("session-worker-1", "assignment-1", "run-1"));
    eventBus.emit(turnStarted("session-worker-1", "assignment-1", "run-1"));

    const service = makeService(store, journal, {
      assignmentReader: new StaticDenAssignmentReader([
        { assignmentId: "assignment-1", isActive: true },
      ]),
    });

    const overview = await service.projectOverview();

    expect(overview.classification.kind).toBe("healthy");
    expect(overview.counts.workerSessions).toBe(1);
    expect(overview.sessions).toHaveLength(1);
    expect(overview.sessions[0]).toMatchObject({
      sessionId: "session-worker-1",
      profileId: "spawned-coder",
      instanceId: "instance-session-worker-1",
      sessionState: "active",
      workerBinding: {
        assignmentId: "assignment-1",
        runId: "run-1",
        taskId: "2116",
        projectId: "pi-crew",
        role: "coder",
      },
      denAssignment: { assignmentId: "assignment-1", isActive: true },
      localLifecycleState: "turn.started",
      lastGatewayEvent: "turn.started",
      classification: "healthy",
    });
  });

  it("classifies remediation-required stuck worker evidence as pi_crew_local", async () => {
    const eventBus = new FakeEventBus();
    const journal = new InMemoryDiagnosticEventJournal(eventBus, { clock: () => now });
    const store = new InMemorySessionStore();
    await store.save(workerSession("session-stuck", "assignment-stuck", "run-stuck"));
    eventBus.emit(workerStuck("session-stuck", "assignment-stuck", "run-stuck"));

    const service = makeService(store, journal, {
      assignmentReader: new StaticDenAssignmentReader([
        { assignmentId: "assignment-stuck", isActive: true },
      ]),
    });

    const overview = await service.projectOverview();

    expect(overview.classification.kind).toBe("pi_crew_local");
    expect(overview.counts.stuckWorkers).toBe(1);
    expect(overview.sessions[0]).toMatchObject({
      sessionId: "session-stuck",
      localLifecycleState: "worker.stuck",
      classification: "pi_crew_local",
    });
    expect(overview.sessions[0]?.evidenceRefs).toContain("worker.stuck:assignment-stuck");
  });

  it("classifies active local workers as workflow_disagreement when Den says terminal", async () => {
    const eventBus = new FakeEventBus();
    const journal = new InMemoryDiagnosticEventJournal(eventBus, { clock: () => now });
    const store = new InMemorySessionStore();
    await store.save(workerSession("session-disagree", "assignment-terminal", "run-terminal"));

    const service = makeService(store, journal, {
      assignmentReader: new StaticDenAssignmentReader([
        { assignmentId: "assignment-terminal", isActive: false, terminalState: "completed" },
      ]),
    });

    const overview = await service.projectOverview();

    expect(overview.classification.kind).toBe("workflow_disagreement");
    expect(overview.sessions[0]).toMatchObject({
      classification: "workflow_disagreement",
      denAssignment: {
        assignmentId: "assignment-terminal",
        isActive: false,
        terminalState: "completed",
      },
    });
  });

  it("redacts secret-shaped event payloads from diagnostic serialization", () => {
    const eventBus = new FakeEventBus();
    const journal = new InMemoryDiagnosticEventJournal(eventBus, { clock: () => now });

    eventBus.emit({
      event: "tool.called",
      payload: {
        toolName: "http_post",
        sessionId: "session-redact",
        params: {
          Authorization: "Bearer super-secret-token",
          nested: { apiKey: "sk-live-secret-value" },
          safe: "visible-value",
        },
      },
    });

    const serialized = JSON.stringify(journal.recent(5));
    expect(serialized).toContain("visible-value");
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("sk-live-secret-value");
    expect(serialized).toContain("[REDACTED]");
  });
});

function makeService(
  sessionStore: InMemorySessionStore,
  eventJournal: InMemoryDiagnosticEventJournal,
  overrides: { readonly assignmentReader?: StaticDenAssignmentReader } = {},
): DiagnosticsService {
  return new DiagnosticsService({
    sessionStore,
    runtimeHealthReader: new StaticRuntimeHealthReader(),
    eventJournal,
    denCoreStatusReader: new StaticStatusReader("ok"),
    denChannelsStatusReader: new StaticStatusReader("ok"),
    mcpStatusReader: new StaticStatusReader("ok"),
    denAssignmentReader: overrides.assignmentReader ?? new StaticDenAssignmentReader([]),
    startedAt: now,
    clock: () => now,
  });
}

function workerSession(sessionId: string, assignmentId: string, runId: string): SessionRecord {
  return {
    id: sessionId,
    profileId: "spawned-coder",
    instanceId: `instance-${sessionId}`,
    kind: "worker",
    createdAt: now,
    lastActiveAt: now,
    state: "active",
    messageCount: 3,
    channelBindings: [],
    workerBinding: {
      assignmentId,
      runId,
      taskId: "2116",
      projectId: "pi-crew",
      role: "coder",
    },
  };
}

function turnStarted(sessionId: string, assignmentId: string, runId: string): GatewayEvent {
  return {
    event: "turn.started",
    payload: {
      sessionId,
      turnNumber: 1,
      assignmentId,
      runId,
      taskId: "2116",
      profileId: "spawned-coder",
    },
  };
}

function workerStuck(sessionId: string, assignmentId: string, runId: string): GatewayEvent {
  return {
    event: "worker.stuck",
    payload: {
      workerIdentity: "pool-coder-03",
      assignmentId: Number(assignmentId.replace(/\D/g, "")) || 99,
      runId,
      taskId: "2116",
      sessionId,
      profileId: "spawned-coder",
      role: "coder",
      lastActivityAt: now,
      lastLifecycleState: "turn.started",
      idleTimeoutMs: 120000,
      remediationRequired: true,
      reason: "idle timeout exceeded",
    },
  };
}
