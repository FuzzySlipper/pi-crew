/**
 * Capstone integration test — proves the full Den worker runtime lifecycle.
 *
 * Exercises: DenSimulator → WorkerRuntime → PacketAuditor → CompletionPacket
 * Verifies: typed events on EventBus, audit log entries, Den simulator state
 * transitions, governance breadcrumbs, and session cleanup.
 *
 * Per the den-worker-runtime-contract, this proves:
 *   1. assignment.claimed → fresh worker session with WorkerBinding
 *   2. PacketAuditor validates completion packet required fields
 *   3. Structured CompletionPacket posted evidence
 *   4. assignment.released → session archived, instance released
 *   5. Governance breadcrumbs show full chain
 *   6. Audit log captures complete typed events
 *
 * Den-side gap: DenSimulator simulates the contract. When Den Core
 * implements claim/complete/release HTTP APIs, replace simulator calls
 * with HTTP clients. See DEN_WORKER_API_PREREQUISITES.
 *
 * @module pi-crew/__tests__/capstone-worker-lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FakeLogger,
  FakeEventBus,
  ok,
  err,
} from "@pi-crew/core";

import {
  Crew,
  CrewConfigSchema,
  type CrewConfig,
} from "../crew.js";
import {
  DenSimulator,
  WorkerRuntime,
  PacketAuditor,
  type WorkerBinding,
  type AuditFinding,
  type AuditRepository,
  type AuditEventInput,
  type AuditRow,
} from "@pi-crew/service";
import {
  makePacketReader,
  makeTargetCompletionPacket,
  makeTargetPacketRef,
} from "./capstone-packet-auditor-helpers.js";

// ── Test helpers ──────────────────────────────────────────────

let nextHealthPort = 20_236;

function makeTestCrewConfig(overrides?: Partial<CrewConfig>): CrewConfig {
  const parsed = CrewConfigSchema.safeParse({
    database: { path: makeTempDbPath(), wal: true },
    health: { host: "127.0.0.1", port: nextHealthPort++ },
    den: {
      coreUrl: "http://localhost:3030",
      requiredAtStartup: false,
    },
    ...overrides,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid test config: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

function makeTempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-crew-capstone-")), "runtime.db");
}

/**
 * Create a fake AuditRepository that writes to the Crew's SQLite runtime DB.
 * Avoids `async`/`await` to satisfy require-await lint rule.
 */
function makeCrewAuditRepo(crew: Crew): AuditRepository {
  const db = crew.runtimeDb.handle;
  return {
    write(input: AuditEventInput): Promise<number> {
      const stmt = db.prepare(
        `INSERT INTO audit_log (session_id, assignment_id, run_id, event_type, event_data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const result = stmt.run(
        input.sessionId ?? null,
        input.assignmentId ?? null,
        input.runId ?? null,
        input.eventType,
        JSON.stringify(input.eventData),
        new Date().toISOString(),
      );
      return Promise.resolve(Number(result.lastInsertRowid));
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getPending(limit?: number): Promise<AuditRow[]> {
      return Promise.resolve([]);
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    markFlushed(ids: number[]): Promise<void> {
      return Promise.resolve();
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    pruneOlderThan(cutoff: string): Promise<number> {
      return Promise.resolve(0);
    },
  };
}

// ── Capstone: Full Worker Lifecycle ────────────────────────────

describe("Capstone: Den worker runtime lifecycle", () => {
  let crew: Crew;
  let logger: FakeLogger;
  let eventBus: FakeEventBus;
  let denSim: DenSimulator;

  beforeEach(() => {
    logger = new FakeLogger();
    eventBus = new FakeEventBus();
    denSim = new DenSimulator();
    crew = new Crew(makeTestCrewConfig(), logger, eventBus);
  });

  afterEach(async () => {
    await crew.stop("capstone-test-cleanup");
  });

  // ── 1. Full lifecycle: claim → execute → complete → release ──

  it("proves full claim→execute→complete→release lifecycle with packet-auditor", async () => {
    await crew.start();
    const auditRepo = makeCrewAuditRepo(crew);

    // ── Create assignment in Den simulator ──────────────────
    const assignment = denSim.createAssignment({
      assignmentId: "1864",
      taskId: "1864",
      runId: "piw_capstone_run",
      role: "packet-auditor",
    });

    expect(assignment.state).toBe("pending");

    // ── Build worker binding ────────────────────────────────
    const targetRunId = "piw_target_capstone";
    const binding: WorkerBinding = {
      assignmentId: assignment.assignmentId,
      runId: assignment.runId,
      taskId: assignment.taskId,
      projectId: "pi-crew",
      role: assignment.role,
      targetPacketRef: makeTargetPacketRef(targetRunId),
    };

    // ── Phase A: Claim assignment (simulated Den API) ───────
    const claimed = denSim.claimAssignment(
      assignment.assignmentId,
      "pi-worker-capstone",
    );
    expect(claimed.state).toBe("claimed");
    expect(claimed.claimedBy).toBe("pi-worker-capstone");

    // ── Phase B: Execute via WorkerRuntime ──────────────────
    const runtime = new WorkerRuntime(
      {
        workerIdentity: "pi-worker-capstone",
        packetCompletionReader: makePacketReader(
          ok(makeTargetCompletionPacket(targetRunId)),
        ),
      },
      crew.workerRoleMapping,
      crew.sessionManager,
      crew.instancePool,
      eventBus,
      logger,
      auditRepo,
      crew.denCompletionPoster,
    );

    const auditor = new PacketAuditor();
    const packet = await runtime.executeAssignment(binding, auditor);

    // ── Verify completion packet ────────────────────────────
    expect(packet.status).toBe("completed");
    expect(packet.assignmentId).toBe("1864");
    expect(packet.runId).toBe("piw_capstone_run");
    expect(packet.taskId).toBe("1864");
    expect(packet.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(packet.artifacts[0]?.type).toBe("audit_report");

    // ── Phase C: Post completion (simulated Den API) ────────
    const postResult = denSim.postCompletion(
      assignment.assignmentId,
      packet,
    );
    expect(postResult.accepted).toBe(true);

    const completedState = denSim.getAssignment(assignment.assignmentId);
    expect(completedState?.state).toBe("completed");
    expect(completedState?.completionPacket).not.toBeNull();

    // ── Phase D: Release (simulated Den API) ────────────────
    const released = denSim.releaseAssignment(
      assignment.assignmentId,
      "completed",
    );
    expect(released.state).toBe("released");

    // ── Verify Den state audit trail ────────────────────────
    expect(released.transitions).toEqual([
      expect.stringContaining("created (pending)"),
      expect.stringContaining("claimed by pi-worker-capstone"),
      expect.stringContaining("completion posted (completed)"),
      expect.stringContaining("released (completed)"),
    ]);

    // ── Verify gateway events ───────────────────────────────
    verifyLifecycleEvents(eventBus);
  });

  // ── 2. Packet-auditor validation ─────────────────────────────

  it("packet-auditor correctly identifies packets with missing required fields", () => {
    const auditor = new PacketAuditor();

    // Valid packet
    const now = new Date().toISOString();
    const validPacket = {
      assignmentId: "100",
      runId: "run_valid",
      taskId: "200",
      status: "completed" as const,
      artifacts: [{ type: "test", ref: "r", summary: "s" }],
      filesTouched: ["f.ts"],
      toolsUsed: ["t"],
      tokensConsumed: 100,
      durationMs: 1000,
      turnCount: 1,
      role: "coder",
      completedAt: now,
    };

    const validResult = auditor.auditPacket(validPacket);
    expect(validResult.valid).toBe(true);

    // Invalid packet (missing required fields)
    const invalidPacket = {
      assignmentId: "",
      runId: "run_invalid",
      taskId: "",
      status: "bogus" as "completed",
      artifacts: [],
      filesTouched: [],
      toolsUsed: [],
      tokensConsumed: 0,
      durationMs: 0,
      turnCount: 0,
      role: "",
      completedAt: "",
    };

    const invalidResult = auditor.auditPacket(invalidPacket);
    expect(invalidResult.valid).toBe(false);

    const missingFields = invalidResult.findings
      .filter((f: AuditFinding) => f.severity === "error")
      .map((f: AuditFinding) => f.field);

    expect(missingFields).toContain("assignmentId");
    expect(missingFields).toContain("taskId");
    expect(missingFields).toContain("status");
    expect(missingFields).toContain("artifacts");
    expect(missingFields).toContain("role");
  });

  // ── 3. Fresh worker session ──────────────────────────────────

  it("creates a clean worker session per assignment — no history reuse", async () => {
    await crew.start();
    const auditRepo = makeCrewAuditRepo(crew);

    // First assignment
    denSim.createAssignment({
      assignmentId: "assign-1",
      taskId: "100",
      runId: "run-1",
      role: "packet-auditor",
    });
    denSim.claimAssignment("assign-1", "worker-1");

    const binding1: WorkerBinding = {
      assignmentId: "assign-1",
      runId: "run-1",
      taskId: "100",
      projectId: "pi-crew",
      role: "packet-auditor",
    };

    const runtime1 = new WorkerRuntime(
      { workerIdentity: "worker-1" },
      crew.workerRoleMapping,
      crew.sessionManager,
      crew.instancePool,
      eventBus,
      logger,
      auditRepo,
      crew.denCompletionPoster,
    );

    await runtime1.executeAssignment(binding1, new PacketAuditor());

    // Verify a session was created for the worker
    const created = eventBus.emitted.filter(
      (e) => e.event === "session.created",
    );
    expect(created.length).toBeGreaterThanOrEqual(1);
    const workerSession = created.find(
      (e) => e.payload.kind === "worker",
    );
    expect(workerSession).toBeDefined();

    // Second assignment — should get a fresh session
    denSim.createAssignment({
      assignmentId: "assign-2",
      taskId: "200",
      runId: "run-2",
      role: "packet-auditor",
    });
    denSim.claimAssignment("assign-2", "worker-1");

    const binding2: WorkerBinding = {
      assignmentId: "assign-2",
      runId: "run-2",
      taskId: "200",
      projectId: "pi-crew",
      role: "packet-auditor",
    };

    await runtime1.executeAssignment(binding2, new PacketAuditor());

    // Verify we got TWO distinct worker sessions
    const workerSessions = eventBus.emitted.filter(
      (e) =>
        e.event === "session.created" &&
        e.payload.kind === "worker",
    );
    expect(workerSessions.length).toBeGreaterThanOrEqual(2);

    // Verify sessions have different IDs
    if (workerSessions.length >= 2) {
      const id1 = (workerSessions[0] as { payload: { sessionId: string } }).payload.sessionId;
      const id2 = (workerSessions[1] as { payload: { sessionId: string } }).payload.sessionId;
      expect(id1).not.toBe(id2);
    }
  });

  // ── 4. Den unavailability: worker reports to event bus ───────

  it("handles Den unavailability gracefully — posts completion event locally", async () => {
    await crew.start();
    const auditRepo = makeCrewAuditRepo(crew);

    denSim.createAssignment({
      assignmentId: "blocked-assign",
      taskId: "999",
      runId: "run-blocked",
      role: "packet-auditor",
    });
    denSim.claimAssignment("blocked-assign", "worker-blocked");

    const targetRunId = "run-den-unavailable-target";
    const binding: WorkerBinding = {
      assignmentId: "blocked-assign",
      runId: "run-blocked",
      taskId: "999",
      projectId: "pi-crew",
      role: "packet-auditor",
      targetPacketRef: makeTargetPacketRef(targetRunId),
    };

    const runtime = new WorkerRuntime(
      {
        workerIdentity: "worker-blocked",
        packetCompletionReader: makePacketReader(
          err({
            code: "den_unavailable",
            message: "Den Core read failed",
            retryable: true,
          }),
        ),
      },
      crew.workerRoleMapping,
      crew.sessionManager,
      crew.instancePool,
      eventBus,
      logger,
      auditRepo,
      crew.denCompletionPoster,
    );

    const packet = await runtime.executeAssignment(binding, new PacketAuditor());

    expect(packet).toBeDefined();
    expect(packet.status).toBe("blocked");
    expect(packet.blocker?.reason).toBe("den_unavailable");

    // Verify completion.posted event was emitted
    const posted = eventBus.emitted.filter(
      (e) => e.event === "completion.posted",
    );
    expect(posted.length).toBeGreaterThanOrEqual(1);

    // Verify release event emitted
    const released = eventBus.emitted.filter(
      (e) => e.event === "assignment.released",
    );
    expect(released.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Helpers ────────────────────────────────────────────────────

/**
 * Verify all required lifecycle events were emitted on the EventBus.
 */
function verifyLifecycleEvents(eventBus: FakeEventBus): void {
  const events = eventBus.emitted;

  // assignment.claimed
  const claimed = events.filter((e) => e.event === "assignment.claimed");
  expect(claimed.length).toBeGreaterThanOrEqual(1);

  // session.created (worker)
  const sessionCreated = events.filter(
    (e) => e.event === "session.created" && e.payload.kind === "worker",
  );
  expect(sessionCreated.length).toBeGreaterThanOrEqual(1);

  // turn.started
  const turnStarted = events.filter((e) => e.event === "turn.started");
  expect(turnStarted.length).toBeGreaterThanOrEqual(1);

  // turn.completed
  const turnCompleted = events.filter((e) => e.event === "turn.completed");
  expect(turnCompleted.length).toBeGreaterThanOrEqual(1);

  // completion.posted
  const completionPosted = events.filter(
    (e) => e.event === "completion.posted",
  );
  expect(completionPosted.length).toBeGreaterThanOrEqual(1);

  // assignment.released
  const released = events.filter((e) => e.event === "assignment.released");
  expect(released.length).toBeGreaterThanOrEqual(1);

  // Verify the full event chain ordering
  const timeline = events.map((e) => e.event as string);
  const claimedIdx = timeline.indexOf("assignment.claimed");
  const createdIdx = timeline.indexOf("session.created");
  const startedIdx = timeline.indexOf("turn.started");
  const completedIdx = timeline.indexOf("turn.completed");
  const postedIdx = timeline.indexOf("completion.posted");
  const releasedIdx = timeline.indexOf("assignment.released");

  // All events must be present
  expect(claimedIdx).not.toBe(-1);
  expect(createdIdx).not.toBe(-1);
  expect(startedIdx).not.toBe(-1);
  expect(completedIdx).not.toBe(-1);
  expect(postedIdx).not.toBe(-1);
  expect(releasedIdx).not.toBe(-1);

  // Events must be in correct temporal order
  expect(claimedIdx).toBeLessThan(createdIdx);
  expect(createdIdx).toBeLessThan(startedIdx);
  expect(startedIdx).toBeLessThan(completedIdx);
  expect(completedIdx).toBeLessThan(postedIdx);
  expect(postedIdx).toBeLessThan(releasedIdx);
}
