/** Tests for WorkerRuntime idle-timeout stuck-worker evidence. */

import { describe, expect, it, beforeEach } from "vitest";
import { FakeEventBus, FakeLogger, type GatewayEvent } from "@pi-crew/core";
import { WorkerRuntime, type WorkerExecutor } from "../../workers/worker-runtime.js";
import type { InstancePool } from "../../instances/instance-pool.js";
import type { WorkerRoleMappingConfig } from "../../workers/worker-role-config.js";
import {
  FakeAuditRepo,
  FakeSessionManager,
  makeAcceptingPoster,
  makeBinding,
  makeFakePool,
  makeFastExecutor,
  makeIdleRoleMapping,
} from "./worker-runtime-test-fixtures.js";

describe("WorkerRuntime idle timeout enforcement", () => {
  let logger: FakeLogger;
  let bus: FakeEventBus;
  let sessionManager: FakeSessionManager;
  let auditRepo: FakeAuditRepo;
  let pool: InstancePool;

  beforeEach(() => {
    logger = new FakeLogger();
    bus = new FakeEventBus();
    sessionManager = new FakeSessionManager();
    auditRepo = new FakeAuditRepo();
    pool = makeFakePool();
  });

  it("emits worker.stuck evidence without silently releasing workflow state", async () => {
    const runtime = makeRuntime(makeIdleRoleMapping(20, 1_000));
    const binding = makeBinding({ assignmentId: "207", taskId: "2067" });

    const packet = await runtime.executeAssignment(
      binding,
      delayedExecutor(80),
    );

    expect(packet.status).toBe("completed");
    const stuck = workerStuckEvents(bus);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.payload).toMatchObject({
      workerIdentity: "test-worker",
      assignmentId: 207,
      runId: "piw_test_run",
      taskId: "2067",
      profileId: "spawned-coder",
      role: "coder",
      lastLifecycleState: "executing",
      idleTimeoutMs: 20,
      remediationRequired: true,
    });

    const stuckIndex = eventIndex("worker.stuck");
    const releaseIndex = eventIndex("assignment.released");
    expect(stuckIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(stuckIndex);
  });

  it("refreshes the idle deadline from executor activity events", async () => {
    const runtime = makeRuntime(makeIdleRoleMapping(35, 1_000));

    await runtime.executeAssignment(
      makeBinding({ taskId: "2067" }),
      activityExecutor(),
    );

    expect(workerStuckEvents(bus)).toHaveLength(0);
  });

  it("does not treat checkpoint waiting as short idle silence", async () => {
    const runtime = makeRuntime(makeIdleRoleMapping(20, 1_000));

    await runtime.executeAssignment(
      makeBinding({ assignmentId: "208", taskId: "2067" }),
      checkpointWaitingExecutor(),
    );

    expect(workerStuckEvents(bus)).toHaveLength(0);
  });

  function makeRuntime(roleMapping: WorkerRoleMappingConfig): WorkerRuntime {
    return new WorkerRuntime(
      { workerIdentity: "test-worker" },
      roleMapping,
      sessionManager,
      pool,
      bus,
      logger,
      auditRepo,
      makeAcceptingPoster(),
    );
  }

  function eventIndex(event: GatewayEvent["event"]): number {
    return bus.emitted.findIndex((entry) => entry.event === event);
  }
});

function workerStuckEvents(
  bus: FakeEventBus,
): Array<Extract<GatewayEvent, { event: "worker.stuck" }>> {
  return bus.emitted.filter(
    (event): event is Extract<GatewayEvent, { event: "worker.stuck" }> =>
      event.event === "worker.stuck",
  );
}

function delayedExecutor(delayMs: number): WorkerExecutor {
  return {
    async execute() {
      await sleep(delayMs);
      return makeFastExecutor().execute({
        binding: makeBinding(),
        session: {
          id: "unused",
          profileId: "unused",
          instanceId: null,
          kind: "worker",
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          state: "active",
          messageCount: 0,
          channelBindings: [],
          workerBinding: makeBinding(),
        },
        emitEvent: () => undefined,
        log: () => undefined,
        writeAudit: () => Promise.resolve(),
      });
    },
  };
}

function activityExecutor(): WorkerExecutor {
  return {
    async execute(context) {
      await sleep(15);
      context.emitEvent({
        event: "tool.called",
        payload: {
          toolName: "context_status",
          sessionId: context.session.id,
        },
      });
      await sleep(15);
      return makeFastExecutor().execute(context);
    },
  };
}

function checkpointWaitingExecutor(): WorkerExecutor {
  return {
    async execute(context) {
      await sleep(10);
      context.emitEvent({
        event: "checkpoint.waiting",
        payload: {
          workerIdentity: "test-worker",
          assignmentId: 208,
          checkpointId: 1,
        },
      });
      await sleep(60);
      return makeFastExecutor().execute(context);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
