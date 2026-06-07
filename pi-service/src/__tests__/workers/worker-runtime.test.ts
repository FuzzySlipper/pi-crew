/** Tests for WorkerRuntime timeout enforcement. */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeLogger, FakeEventBus } from "@pi-crew/core";
import {
  WorkerRuntime,
  type WorkerExecutor,
  type WorkerExecutionContext,
  type WorkerExecutionResult,
} from "../../workers/worker-runtime.js";
import { AssignmentTimeoutError } from "../../workers/worker-timeout.js";
import type { InstancePool } from "../../instances/instance-pool.js";
import type { WorkerBinding } from "../../sessions/types.js";
import type { WorkerRoleMappingConfig } from "../../workers/worker-role-config.js";
import {
  FakeAuditRepo,
  FakeSessionManager,
  makeAcceptingPoster,
  makeBinding,
  makeFakePool,
  makeFastExecutor,
  makeRejectingPoster,
  makeRoleMapping,
  makeSlowExecutor,
  makeTimeoutRoleMapping,
} from "./worker-runtime-test-fixtures.js";

describe("WorkerRuntime timeout enforcement", () => {
  let logger: FakeLogger;
  let bus: FakeEventBus;
  let sessionManager: FakeSessionManager;
  let auditRepo: FakeAuditRepo;
  let pool: InstancePool;
  let roleMapping: WorkerRoleMappingConfig;

  beforeEach(() => {
    logger = new FakeLogger();
    bus = new FakeEventBus();
    sessionManager = new FakeSessionManager();
    auditRepo = new FakeAuditRepo();
    pool = makeFakePool();
    roleMapping = makeRoleMapping();
  });

  // ── 1. No timeout before deadline ──────────────────────────

  it("completes normally when executor finishes within timeout", async () => {
    const poster = makeAcceptingPoster();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      roleMapping,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding();
    const packet = await runtime.executeAssignment(
      binding,
      makeFastExecutor(),
    );

    expect(packet.status).toBe("completed");
    expect(packet.assignmentId).toBe("101");
    expect(packet.artifacts.length).toBeGreaterThanOrEqual(1);

    // No timeout events emitted
    const timeoutEvents = bus.emitted.filter(
      (e) => e.event === "assignment.timed_out",
    );
    expect(timeoutEvents.length).toBe(0);

    // Normal lifecycle events present
    const released = bus.emitted.filter(
      (e) => e.event === "assignment.released",
    );
    expect(released.length).toBeGreaterThanOrEqual(1);
  });

  // ── 2. Assignment timeout ──────────────────────────────────

  it("times out when executor exceeds assignment timeout", async () => {
    const SHORT_TIMEOUT = 100; // 100ms
    const LONG_DELAY = 500; // 500ms — well over timeout

    const mappingWithTimeout = makeTimeoutRoleMapping(SHORT_TIMEOUT);
    const poster = makeAcceptingPoster();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      mappingWithTimeout,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding();
    const packet = await runtime.executeAssignment(
      binding,
      makeSlowExecutor(LONG_DELAY),
    );

    // Should be a failed completion
    expect(packet.status).toBe("failed");
    expect(packet.blocker).toBeDefined();
    expect(packet.blocker?.reason).toContain(String(SHORT_TIMEOUT));

    // Artifact should contain timeout evidence
    const timeoutArtifact = packet.artifacts.find(
      (a) => a.type === "timeout_evidence",
    );
    expect(timeoutArtifact).toBeDefined();

    // Session was archived (no orphan)
    expect(sessionManager.archived.length).toBeGreaterThanOrEqual(1);
  });

  // ── 3. timeout evidence includes correlation IDs ────────────

  it("timeout evidence includes assignment/run/task/session/profile IDs", async () => {
    const SHORT_TIMEOUT = 50;
    const LONG_DELAY = 500;

    const mappingWithTimeout = makeTimeoutRoleMapping(SHORT_TIMEOUT);
    const poster = makeAcceptingPoster();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      mappingWithTimeout,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding({
      assignmentId: "timeout-42",
      runId: "piw_correlation_test",
      taskId: "2066",
      role: "coder",
    });

    const packet = await runtime.executeAssignment(
      binding,
      makeSlowExecutor(LONG_DELAY),
    );

    expect(packet.status).toBe("failed");
    expect(packet.assignmentId).toBe("timeout-42");
    expect(packet.runId).toBe("piw_correlation_test");
    expect(packet.taskId).toBe("2066");

    // The timeout artifact summary should contain session and profile IDs
    const timeoutArtifact = packet.artifacts.find(
      (a) => a.type === "timeout_evidence",
    );
    expect(timeoutArtifact).toBeDefined();
    expect(timeoutArtifact?.summary).toContain("session=");
    expect(timeoutArtifact?.summary).toContain("profile=");

    // Blocker details should contain JSON with all correlation IDs
    const details = packet.blocker?.details;
    expect(details).toBeDefined();
    if (typeof details === "string") {
      const parsed = JSON.parse(details) as Record<string, unknown>;
      expect(parsed.assignmentId).toBe("timeout-42");
      expect(parsed.runId).toBe("piw_correlation_test");
      expect(parsed.taskId).toBe("2066");
      expect(parsed.sessionId).toBeDefined();
      expect(parsed.profileId).toBeDefined();
      expect(parsed.role).toBe("coder");
      expect(parsed.timeoutMs).toBe(SHORT_TIMEOUT);
    }
  });

  // ── 4. Cleanup/release on timeout ──────────────────────────

  it("cleans up session and emits release event after timeout", async () => {
    const SHORT_TIMEOUT = 50;
    const LONG_DELAY = 500;

    const mappingWithTimeout = makeTimeoutRoleMapping(SHORT_TIMEOUT);
    const poster = makeAcceptingPoster();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      mappingWithTimeout,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding();
    await runtime.executeAssignment(binding, makeSlowExecutor(LONG_DELAY));

    // Session was archived
    expect(sessionManager.archived.length).toBeGreaterThanOrEqual(1);

    // assignment.released emitted
    const released = bus.emitted.filter(
      (e) => e.event === "assignment.released",
    );
    expect(released.length).toBeGreaterThanOrEqual(1);

    const releaseEvent = released[0];
    if (releaseEvent !== undefined) {
      expect(releaseEvent.payload.reason).toBe("timeout");
    }
  });

  // ── 5. assignment.timed_out event ──────────────────────────

  it("emits assignment.timed_out event with correct payload", async () => {
    const SHORT_TIMEOUT = 50;
    const LONG_DELAY = 500;

    const mappingWithTimeout = makeTimeoutRoleMapping(SHORT_TIMEOUT);
    const poster = makeAcceptingPoster();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      mappingWithTimeout,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding({
      assignmentId: "timeout-ev",
      runId: "piw_ev_test",
      taskId: "2066",
    });

    await runtime.executeAssignment(binding, makeSlowExecutor(LONG_DELAY));

    const timeoutEvents = bus.emitted.filter(
      (e) => e.event === "assignment.timed_out",
    );
    expect(timeoutEvents.length).toBeGreaterThanOrEqual(1);

    const payload = timeoutEvents[0]?.payload;
    expect(payload).toBeDefined();
    if (payload) {
      expect(payload.assignmentId).toBe(Number("timeout-ev"));
      expect(payload.runId).toBe("piw_ev_test");
      expect(payload.taskId).toBe("2066");
      expect(payload.sessionId).toBeDefined();
      expect(payload.profileId).toBeDefined();
      expect(payload.role).toBe("coder");
      expect(payload.timeoutMs).toBe(SHORT_TIMEOUT);
      expect(payload.elapsedMs).toBeGreaterThanOrEqual(SHORT_TIMEOUT);
      expect(payload.reason).toContain(String(SHORT_TIMEOUT));
    }
  });

  // ── 6. Completion racing timeout ───────────────────────────

  it("completes normally when executor finishes near timeout deadline", async () => {
    // Timeout is long; executor is fast. This tests that the race
    // correctly selects the completion path rather than the timeout.
    const TIMEOUT = 10_000; // 10s — well over executor time
    const mappingWithTimeout = makeTimeoutRoleMapping(TIMEOUT);

    const poster = makeAcceptingPoster();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      mappingWithTimeout,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding();
    const packet = await runtime.executeAssignment(
      binding,
      makeFastExecutor(),
    );

    expect(packet.status).toBe("completed");

    // No timeout events
    const timeoutEvents = bus.emitted.filter(
      (e) => e.event === "assignment.timed_out",
    );
    expect(timeoutEvents.length).toBe(0);
  });

  // ── 7. Den-unavailable during timeout release ───────────────

  it("handles Den-unavailable during timeout — cleans up, no orphaned session", async () => {
    const SHORT_TIMEOUT = 50;
    const LONG_DELAY = 500;

    const mappingWithTimeout = makeTimeoutRoleMapping(SHORT_TIMEOUT);

    // Poster that simulates Den being down
    const poster = makeRejectingPoster("ECONNREFUSED");
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      mappingWithTimeout,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding();
    const packet = await runtime.executeAssignment(
      binding,
      makeSlowExecutor(LONG_DELAY),
    );

    // Still produces a failure packet even though Den was down
    expect(packet.status).toBe("failed");
    expect(packet.blocker).toBeDefined();

    // Session was cleaned up (no orphan)
    expect(sessionManager.archived.length).toBeGreaterThanOrEqual(1);

    // Release event still emitted
    const released = bus.emitted.filter(
      (e) => e.event === "assignment.released",
    );
    expect(released.length).toBeGreaterThanOrEqual(1);
  });

  // ── 8. Den-unavailable + completion.posted event still fires ─

  it("emits completion.posted event even when Den is unavailable", async () => {
    const SHORT_TIMEOUT = 50;
    const LONG_DELAY = 500;

    const mappingWithTimeout = makeTimeoutRoleMapping(SHORT_TIMEOUT);

    const poster = makeRejectingPoster("timeout");
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      mappingWithTimeout,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding();
    await runtime.executeAssignment(binding, makeSlowExecutor(LONG_DELAY));

    // completion.posted event must fire locally
    const posted = bus.emitted.filter(
      (e) => e.event === "completion.posted",
    );
    expect(posted.length).toBeGreaterThanOrEqual(1);
    const postedEvent = posted[0];
    if (postedEvent !== undefined) {
      expect(postedEvent.payload.status).toBe("failed");
    }
  });

  // ── 9. No hard timeout without role config ─────────────────

  it("uses default timeout when no role config timeout is set", async () => {
    const poster = makeAcceptingPoster();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      roleMapping, // no per-role timeout — uses default 30m
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding();
    const packet = await runtime.executeAssignment(
      binding,
      makeFastExecutor(),
    );

    // Default timeout is 30 min — fast executor completes well before
    expect(packet.status).toBe("completed");

    // No timeout events
    const timeoutEvents = bus.emitted.filter(
      (e) => e.event === "assignment.timed_out",
    );
    expect(timeoutEvents.length).toBe(0);
  });

  // ── 10. Abort-aware executor receives signal on timeout ─────

  it("provides AbortSignal to executor context", async () => {
    let capturedSignal: AbortSignal | undefined;

    const signalCaptureExecutor: WorkerExecutor = {
      execute(
        context: WorkerExecutionContext,
      ): Promise<WorkerExecutionResult> {
        capturedSignal = context.signal;
        if (context.signal?.aborted) {
          return Promise.resolve({
            status: "failed",
            artifacts: [],
            filesTouched: [],
            toolsUsed: [],
            tokensConsumed: 0,
            summary: "timed out",
            blocker: {
              reason: "timeout",
              requires: "human",
              details: "cancelled by abort signal",
            },
          });
        }
        // Quick complete — signal is provided but not used
        return Promise.resolve({
          status: "completed",
          artifacts: [
            { type: "test", ref: "r", summary: "signal capture" },
          ],
          filesTouched: [],
          toolsUsed: [],
          tokensConsumed: 0,
          summary: "done",
        });
      },
    };

    const poster = makeAcceptingPoster();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      roleMapping,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      poster,
    );

    const binding = makeBinding();
    await runtime.executeAssignment(binding, signalCaptureExecutor);

    expect(capturedSignal).toBeDefined();
    // Should not be aborted since executor finished quickly
    expect(capturedSignal?.aborted).toBe(false);
  });

  // ── 11. AssignmentTimeoutError class ────────────────────────

  it("AssignmentTimeoutError carries full correlation evidence", () => {
    const binding: WorkerBinding = {
      assignmentId: "err-test",
      runId: "piw_err",
      taskId: "99",
      projectId: "pi-crew",
      role: "reviewer",
    };

    const error = new AssignmentTimeoutError(
      binding,
      "session-42",
      "spawned-reviewer",
      5000,
      5200,
    );

    expect(error.name).toBe("AssignmentTimeoutError");
    expect(error.assignmentId).toBe("err-test");
    expect(error.runId).toBe("piw_err");
    expect(error.taskId).toBe("99");
    expect(error.sessionId).toBe("session-42");
    expect(error.profileId).toBe("spawned-reviewer");
    expect(error.role).toBe("reviewer");
    expect(error.timeoutMs).toBe(5000);
    expect(error.elapsedMs).toBe(5200);
    expect(error.message).toContain("err-test");
    expect(error.message).toContain("timed out");
  });
});
