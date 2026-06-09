import { describe, expect, it } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { createDenAssignmentLoop, type DenAssignmentLoopRunner } from "../den-assignment-loop.js";

class FakeRunner implements DenAssignmentLoopRunner {
  readonly calls: number[] = [];
  readonly started: number[] = [];
  readonly releaseNext: Array<() => void> = [];

  constructor(
    private readonly results: Array<Awaited<ReturnType<DenAssignmentLoopRunner["runOnce"]>>>,
  ) {}

  async runOnce(): Promise<Awaited<ReturnType<DenAssignmentLoopRunner["runOnce"]>>> {
    this.calls.push(Date.now());
    this.started.push(this.calls.length);
    const result = this.results.shift() ?? {
      status: "no_assignment",
      reason: "none_available",
      diagnostic: "none",
    };
    if (result.status === "completed") {
      await new Promise<void>((resolve) => {
        this.releaseNext.push(resolve);
      });
    }
    return result;
  }
}

class ImmediateDelay {
  readonly waits: number[] = [];

  wait(ms: number): Promise<void> {
    this.waits.push(ms);
    return Promise.resolve();
  }
}

const completed = {
  status: "completed" as const,
  packet: {
    assignmentId: "1",
    runId: "run-1",
    taskId: "2188",
    role: "coder",
    status: "completed" as const,
    artifacts: [],
    filesTouched: [],
    toolsUsed: [],
    tokensConsumed: 1,
    durationMs: 10,
    turnCount: 1,
    completedAt: "2026-06-09T13:20:00.000Z",
  },
};

function logger(): FakeLogger {
  return new FakeLogger();
}

describe("DenAssignmentLoop", () => {
  it("runs one polling tick and waits after no assignment", async () => {
    const delay = new ImmediateDelay();
    const runner = new FakeRunner([
      { status: "no_assignment", reason: "none_available", diagnostic: "empty" },
    ]);
    const loop = createDenAssignmentLoop({
      workerIdentity: "pi-crew-coder-1",
      runner,
      pollIntervalMs: 25,
      delay: delay.wait.bind(delay),
      logger: logger(),
    });

    await expect(loop.runTick()).resolves.toEqual({ status: "no_assignment" });

    expect(runner.calls).toHaveLength(1);
    expect(delay.waits).toEqual([25]);
  });

  it("continues after successful and failed assignment ticks", async () => {
    const delay = new ImmediateDelay();
    const runner = new FakeRunner([completed, { status: "failed", error: "model unavailable" }]);
    const loop = createDenAssignmentLoop({
      workerIdentity: "pi-crew-coder-1",
      runner,
      pollIntervalMs: 10,
      delay: delay.wait.bind(delay),
      logger: logger(),
    });

    const first = loop.runTick();
    runner.releaseNext[0]?.();
    await expect(first).resolves.toEqual({ status: "assignment_processed" });
    await expect(loop.runTick()).resolves.toEqual({ status: "assignment_processed" });

    expect(runner.calls).toHaveLength(2);
    expect(delay.waits).toEqual([10, 10]);
  });

  it("skips polling while drain mode is active", async () => {
    const delay = new ImmediateDelay();
    const runner = new FakeRunner([completed]);
    const loop = createDenAssignmentLoop({
      workerIdentity: "pi-crew-coder-1",
      runner,
      pollIntervalMs: 50,
      delay: delay.wait.bind(delay),
      logger: logger(),
      shouldAcceptWork: () => false,
    });

    await expect(loop.runTick()).resolves.toEqual({ status: "drained" });

    expect(runner.calls).toEqual([]);
    expect(delay.waits).toEqual([50]);
  });

  it("does not overlap assignment execution for the same worker", async () => {
    const delay = new ImmediateDelay();
    const runner = new FakeRunner([completed]);
    const loop = createDenAssignmentLoop({
      workerIdentity: "pi-crew-coder-1",
      runner,
      pollIntervalMs: 5,
      delay: delay.wait.bind(delay),
      logger: logger(),
    });

    const first = loop.runTick();
    await expect(loop.runTick()).resolves.toEqual({ status: "busy" });
    runner.releaseNext[0]?.();
    await expect(first).resolves.toEqual({ status: "assignment_processed" });

    expect(runner.calls).toHaveLength(1);
  });

  it("start and stop drive bounded polling without accepting new ticks after stop", async () => {
    const delay = new ImmediateDelay();
    const runner = new FakeRunner([
      { status: "no_assignment", reason: "none_available", diagnostic: "empty" },
    ]);
    const loop = createDenAssignmentLoop({
      workerIdentity: "pi-crew-coder-1",
      runner,
      pollIntervalMs: 5,
      delay: delay.wait.bind(delay),
      logger: logger(),
    });

    loop.start();
    await Promise.resolve();
    await loop.stop("test");
    await expect(loop.runTick()).resolves.toEqual({ status: "stopped" });

    expect(runner.calls.length).toBeGreaterThanOrEqual(1);
    expect(loop.isRunning).toBe(false);
  });
});
