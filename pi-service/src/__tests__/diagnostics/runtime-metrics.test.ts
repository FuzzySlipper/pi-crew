/** Tests for runtime-local metrics projection and Prometheus rendering. */
import { FakeEventBus } from "@pi-crew/core";
import { describe, expect, it } from "vitest";

import {
  RuntimeMetricsCollector,
  renderPrometheusMetrics,
} from "../../diagnostics/runtime-metrics.js";
import type { DiagnosticsOverview } from "../../diagnostics/types.js";

const startedAt = "2026-06-08T12:00:00.000Z";
const now = "2026-06-08T12:02:03.000Z";

describe("RuntimeMetricsCollector", () => {
  it("tracks receive, claim, complete, fail, and release counters from GatewayEvents", () => {
    const eventBus = new FakeEventBus();
    const collector = new RuntimeMetricsCollector(eventBus, {
      startedAt,
      clock: () => now,
    });

    eventBus.emit({
      event: "session.routing",
      payload: { sessionId: "session-1", channelId: "channel-1", reason: "existing_session" },
    });
    eventBus.emit({
      event: "assignment.claimed",
      payload: { assignmentId: 101, workerIdentity: "worker-1", taskId: 2054 },
    });
    eventBus.emit({
      event: "completion.posted",
      payload: { assignmentId: "101", runId: "run-1", taskId: "2054", status: "completed", accepted: true },
    });
    eventBus.emit({
      event: "turn.errored",
      payload: { sessionId: "session-1", turnNumber: 2, error: "boom" },
    });
    eventBus.emit({
      event: "assignment.released",
      payload: { assignmentId: 101, workerIdentity: "worker-1", reason: "completed" },
    });

    expect(collector.snapshot()).toMatchObject({
      uptimeSeconds: 123,
      receivedTotal: 1,
      assignmentsClaimedTotal: 1,
      completionsPostedTotal: 1,
      completionFailuresTotal: 1,
      assignmentsReleasedTotal: 1,
    });
  });

  it("renders valid Prometheus text without Den workflow payloads", () => {
    const eventBus = new FakeEventBus();
    const collector = new RuntimeMetricsCollector(eventBus, {
      startedAt,
      clock: () => now,
    });
    collector.recordCursorLag(7);
    collector.recordLifecycleWriteFailure();
    eventBus.emit({
      event: "assignment.claimed",
      payload: { assignmentId: 202, workerIdentity: "worker-secret", taskId: 2054 },
    });

    const text = renderPrometheusMetrics(collector.snapshot(), overview());

    expect(text).toContain("# HELP pi_crew_runtime_uptime_seconds");
    expect(text).toContain("# TYPE pi_crew_runtime_uptime_seconds gauge");
    expect(text).toContain("pi_crew_runtime_uptime_seconds 123");
    expect(text).toContain("pi_crew_active_sessions 2");
    expect(text).toContain("pi_crew_active_worker_assignments 1");
    expect(text).toContain("pi_crew_cursor_lag_events 7");
    expect(text).toContain("pi_crew_lifecycle_write_failures_total 1");
    expect(text).toContain("pi_crew_runtime_config_version_info{version=\"test-version\"} 1");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("worker-secret");
    expect(text).not.toContain("assignmentId");
  });
});

function overview(): DiagnosticsOverview {
  return {
    service: {
      status: "ok",
      version: "test-version",
      uptimeSeconds: 123,
      startedAt,
      drainMode: "inactive",
    },
    classification: { kind: "healthy", summary: "ok" },
    denCore: { status: "ok", lastOkAt: now },
    denChannels: { status: "ok", lastOkAt: now },
    mcp: { status: "ok", lastOkAt: now },
    runtimeDb: {
      status: "ok",
      path: "/tmp/pi-crew.sqlite",
      walEnabled: true,
      tableCount: 4,
      schemaVersion: 1,
    },
    counts: {
      activeSessions: 2,
      workerSessions: 1,
      conversationalSessions: 1,
      activeAssignmentsLocal: 1,
      stuckWorkers: 0,
      checkpointWaiting: 0,
      degradedConversationalSessions: 0,
    },
    sessions: [],
    recentEvents: [],
  };
}
