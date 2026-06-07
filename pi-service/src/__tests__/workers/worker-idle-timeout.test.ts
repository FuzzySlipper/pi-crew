/**
 * Idle timeout watchdog — monitors worker activity and emits worker.stuck
 * evidence when idleTimeoutMs elapses without a touch().
 *
 * @module pi-service/__tests__/workers/worker-idle-timeout.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GatewayEvent, WorkerStuckPayload } from "@pi-crew/core";
import { FakeEventBus } from "@pi-crew/core";
import { IdleTimeoutWatchdog } from "../../workers/worker-idle-timeout.js";

// ── Helpers ─────────────────────────────────────────────────────

interface BusWithFilter extends FakeEventBus {
  emittedByEvent(event: string): GatewayEvent[];
}

function makeFakeEventBus(): BusWithFilter {
  const bus = new FakeEventBus() as BusWithFilter;
  bus.emittedByEvent = (event: string): GatewayEvent[] => {
    return (bus as FakeEventBus).emitted.filter((e) => e.event === event);
  };
  return bus;
}

function makeCorrelation(binding?: Partial<{
  assignmentId: number;
  runId: string;
  taskId: string;
}>): {
  assignmentId: number;
  runId: string;
  taskId: string;
} {
  return {
    assignmentId: binding?.assignmentId ?? 42,
    runId: binding?.runId ?? "piw_test_run",
    taskId: binding?.taskId ?? "99",
  };
}

function stuckPayload(bus: BusWithFilter): WorkerStuckPayload {
  const events = bus.emittedByEvent("worker.stuck");
  expect(events.length).toBeGreaterThanOrEqual(1);
  const last = events[events.length - 1];
  if (last === undefined || last.event !== "worker.stuck") {
    throw new Error("expected worker.stuck event");
  }
  return last.payload;
}

describe("IdleTimeoutWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Activity refresh resets idle deadline ──────────────────

  it("activity refreshes the idle deadline", () => {
    const bus = makeFakeEventBus();
    const correlation = makeCorrelation();
    const IDLE_MS = 5000;
    const w = new IdleTimeoutWatchdog({
      idleTimeoutMs: IDLE_MS,
      eventBus: bus,
      workerIdentity: "test-worker",
      assignmentId: correlation.assignmentId,
      runId: correlation.runId,
      taskId: correlation.taskId,
    });

    w.start("executing");

    vi.advanceTimersByTime(IDLE_MS - 100);
    w.touch("executing");

    vi.advanceTimersByTime(200);
    const stuckEvents = bus.emittedByEvent("worker.stuck");
    expect(stuckEvents.length).toBe(0);

    vi.advanceTimersByTime(IDLE_MS - 200);
    const stuckAfterFull = bus.emittedByEvent("worker.stuck");
    expect(stuckAfterFull.length).toBe(1);
  });

  // ── 2. Idle expiry emits worker.stuck ─────────────────────────

  it("idle expiry emits worker.stuck with correlation and state", () => {
    const bus = makeFakeEventBus();
    const correlation = makeCorrelation();
    const IDLE_MS = 3000;
    const w = new IdleTimeoutWatchdog({
      idleTimeoutMs: IDLE_MS,
      eventBus: bus,
      workerIdentity: "test-worker-2",
      assignmentId: correlation.assignmentId,
      runId: correlation.runId,
      taskId: correlation.taskId,
    });

    w.start("executing");
    vi.advanceTimersByTime(IDLE_MS + 10);

    const stuckEvents = bus.emittedByEvent("worker.stuck");
    expect(stuckEvents.length).toBe(1);
    const payload = stuckPayload(bus);
    expect(payload.workerIdentity).toBe("test-worker-2");
    expect(payload.assignmentId).toBe(correlation.assignmentId);
    expect(payload.runId).toBe(correlation.runId);
    expect(payload.taskId).toBe(correlation.taskId);
    expect(payload.lastLifecycleState).toBe("executing");
    expect(typeof payload.lastActivityAt).toBe("string");
    expect(payload.idleTimeoutMs).toBe(IDLE_MS);
    expect(typeof payload.reason).toBe("string");
    expect(payload.reason.length).toBeGreaterThan(0);
  });

  // ── 3. No duplicate stuck spam ────────────────────────────────

  it("does not emit duplicate worker.stuck events", () => {
    const bus = makeFakeEventBus();
    const correlation = makeCorrelation();
    const IDLE_MS = 2000;
    const w = new IdleTimeoutWatchdog({
      idleTimeoutMs: IDLE_MS,
      eventBus: bus,
      workerIdentity: "test-worker-3",
      assignmentId: correlation.assignmentId,
      runId: correlation.runId,
      taskId: correlation.taskId,
    });

    w.start("executing");
    vi.advanceTimersByTime(IDLE_MS + 10);

    expect(bus.emittedByEvent("worker.stuck").length).toBe(1);

    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(bus.emittedByEvent("worker.stuck").length).toBe(1);
  });

  // ── 4. Checkpoint waiting has own deadline ────────────────────

  it("checkpoint waiting is not mistaken for idle silence", () => {
    const bus = makeFakeEventBus();
    const correlation = makeCorrelation();
    const IDLE_MS = 2000;

    const CHECKPOINT_DEADLINE_MS = 30000;
    const w = new IdleTimeoutWatchdog({
      idleTimeoutMs: IDLE_MS,
      eventBus: bus,
      workerIdentity: "test-worker-4",
      assignmentId: correlation.assignmentId,
      runId: correlation.runId,
      taskId: correlation.taskId,
      checkpointDeadlineMs: CHECKPOINT_DEADLINE_MS,
    });

    w.start("checkpoint_waiting");

    vi.advanceTimersByTime(IDLE_MS + 100);
    expect(bus.emittedByEvent("worker.stuck").length).toBe(0);

    vi.advanceTimersByTime(CHECKPOINT_DEADLINE_MS - IDLE_MS);
    expect(bus.emittedByEvent("worker.stuck").length).toBe(1);

    const payload = stuckPayload(bus);
    expect(payload.lastLifecycleState).toBe("checkpoint_waiting");
  });

  // ── 5. State transitions track lifecycle ──────────────────────

  it("tracks last lifecycle state through transitions", () => {
    const bus = makeFakeEventBus();
    const correlation = makeCorrelation();
    const IDLE_MS = 1000;
    const w = new IdleTimeoutWatchdog({
      idleTimeoutMs: IDLE_MS,
      eventBus: bus,
      workerIdentity: "test-worker-5",
      assignmentId: correlation.assignmentId,
      runId: correlation.runId,
      taskId: correlation.taskId,
    });

    w.start("executing");
    w.touch("tool_calling");
    w.touch("checkpoint_waiting");

    // checkpoint_waiting uses longer deadline; advance past it
    vi.advanceTimersByTime(IDLE_MS * 10 + 10);

    const payload = stuckPayload(bus);
    expect(payload.lastLifecycleState).toBe("checkpoint_waiting");
  });

  // ── 6. Stop cancels timer ─────────────────────────────────────

  it("stop cancels the timer and prevents stuck emission", () => {
    const bus = makeFakeEventBus();
    const correlation = makeCorrelation();
    const IDLE_MS = 2000;
    const w = new IdleTimeoutWatchdog({
      idleTimeoutMs: IDLE_MS,
      eventBus: bus,
      workerIdentity: "test-worker-6",
      assignmentId: correlation.assignmentId,
      runId: correlation.runId,
      taskId: correlation.taskId,
    });

    w.start("executing");
    vi.advanceTimersByTime(IDLE_MS - 100);
    w.stop();

    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(bus.emittedByEvent("worker.stuck").length).toBe(0);
  });
});
