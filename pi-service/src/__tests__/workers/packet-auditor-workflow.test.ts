/**
 * PacketAuditor workflow tests.
 *
 * These tests prove the deterministic Den-backed path behind the
 * supervised packet-auditor role: actual packet references are fetched
 * through an injected Den reader and all success/failure outcomes post
 * machine-checkable completion packets through CompletionPoster.
 *
 * @module pi-service/__tests__/workers/packet-auditor-workflow
 */

import { describe, it, expect } from "vitest";
import type {
  CompletionPacket,
  CompletionPostResult,
  Result,
} from "@pi-crew/core";
import { err, ok } from "@pi-crew/core";
import type { CompletionPoster } from "@pi-crew/tools";
import type { WorkerBinding } from "../../sessions/types.js";
import { PacketAuditor } from "../../workers/packet-auditor.js";
import type {
  PacketAuditFetchFailure,
  PacketCompletionReader,
} from "../../workers/packet-auditor-workflow.js";
import { runPacketAuditWorkflow } from "../../workers/packet-auditor-workflow.js";
import type { TargetPacketRef } from "../../workers/worker-role-assembly.js";

function makeAuditorBinding(): WorkerBinding {
  return {
    assignmentId: "audit-assignment-01",
    runId: "piw_auditor_run_01",
    taskId: "2049",
    projectId: "pi-crew",
    role: "packet-auditor",
  };
}

function makeTargetRef(): TargetPacketRef {
  return {
    projectId: "pi-crew",
    taskId: "1852",
    runId: "piw_20260605055314_f4b9fc66",
  };
}

function makeCompletionPacket(
  overrides?: Partial<CompletionPacket>,
): CompletionPacket {
  return {
    assignmentId: "189",
    runId: "piw_20260605055314_f4b9fc66",
    taskId: "1852",
    status: "completed",
    artifacts: [
      {
        type: "implementation_packet",
        ref: "message/10882",
        summary: "pi-core foundation implementation packet",
      },
    ],
    filesTouched: ["pi-core/src/types.ts"],
    toolsUsed: ["den_get_task", "post_worker_completion_packet"],
    tokensConsumed: 1200,
    durationMs: 30_000,
    turnCount: 2,
    role: "coder",
    completedAt: "2026-06-05T06:05:00.000Z",
    ...overrides,
  };
}

function makeReader(
  result: Result<CompletionPacket, PacketAuditFetchFailure>,
): PacketCompletionReader {
  return {
    getLatestWorkerCompletion(ref: TargetPacketRef) {
      expect(ref).toEqual(makeTargetRef());
      return Promise.resolve(result);
    },
  };
}

function capturePoster(posted: CompletionPacket[]): CompletionPoster {
  return (packet: CompletionPacket): Promise<CompletionPostResult> => {
    posted.push(packet);
    return Promise.resolve({ accepted: true, message: "accepted" });
  };
}

describe("runPacketAuditWorkflow", () => {
  it("fetches and audits an actual Den packet reference", async () => {
    const posted: CompletionPacket[] = [];
    const result = await runPacketAuditWorkflow({
      auditorBinding: makeAuditorBinding(),
      targetPacketRef: makeTargetRef(),
      reader: makeReader(ok(makeCompletionPacket())),
      poster: capturePoster(posted),
      auditor: new PacketAuditor(),
      auditorSessionId: "session-audit-01",
      auditorProfileId: "packet-auditor",
      now: () => "2026-06-07T10:20:00.000Z",
    });

    expect(result.auditResult?.valid).toBe(true);
    expect(result.fetchFailure).toBeUndefined();
    expect(posted).toHaveLength(1);
    expect(result.completionPacket).toBe(posted[0]);
    expect(posted[0]?.status).toBe("completed");
    expect(posted[0]?.assignmentId).toBe("audit-assignment-01");
    expect(posted[0]?.runId).toBe("piw_auditor_run_01");
    expect(posted[0]?.taskId).toBe("2049");
    expect(posted[0]?.role).toBe("packet-auditor");
    expect(posted[0]?.artifacts[0]?.ref).toBe(
      "den-worker-run/piw_20260605055314_f4b9fc66",
    );
    expect(posted[0]?.artifacts[1]?.type).toBe("audit_context");
    expect(posted[0]?.toolsUsed).toContain(
      "den_get_latest_worker_completion",
    );
    expect(result.postResult.accepted).toBe(true);
  });

  it("posts a completed audit packet for malformed target packets", async () => {
    const posted: CompletionPacket[] = [];
    const malformed = makeCompletionPacket({
      assignmentId: "",
      artifacts: [],
      tokensConsumed: -1,
      role: "",
    });

    const result = await runPacketAuditWorkflow({
      auditorBinding: makeAuditorBinding(),
      targetPacketRef: makeTargetRef(),
      reader: makeReader(ok(malformed)),
      poster: capturePoster(posted),
      auditor: new PacketAuditor(),
      auditorSessionId: "session-audit-01",
      auditorProfileId: "packet-auditor",
      now: () => "2026-06-07T10:20:01.000Z",
    });

    expect(result.auditResult?.valid).toBe(false);
    expect(result.auditResult?.findings.length).toBeGreaterThan(0);
    expect(posted[0]?.status).toBe("completed");
    expect(posted[0]?.artifacts[0]?.summary).toContain("error(s)");
    expect(posted[0]?.blocker).toBeUndefined();
  });

  it("posts a structured blocked packet when the target packet is missing", async () => {
    const posted: CompletionPacket[] = [];
    const failure: PacketAuditFetchFailure = {
      code: "missing_packet",
      message: "No completion packet found for target run",
      retryable: false,
    };

    const result = await runPacketAuditWorkflow({
      auditorBinding: makeAuditorBinding(),
      targetPacketRef: makeTargetRef(),
      reader: makeReader(err(failure)),
      poster: capturePoster(posted),
      auditor: new PacketAuditor(),
      auditorSessionId: "session-audit-01",
      auditorProfileId: "packet-auditor",
      now: () => "2026-06-07T10:20:02.000Z",
    });

    expect(result.auditResult).toBeUndefined();
    expect(result.fetchFailure).toEqual(failure);
    expect(posted[0]?.status).toBe("blocked");
    expect(posted[0]?.blocker?.reason).toBe("missing_packet");
    expect(posted[0]?.blocker?.requires).toBe("human");
    expect(posted[0]?.artifacts[0]?.type).toBe("audit_fetch_failure");
  });

  it("posts a dependency blocker when Den is unavailable", async () => {
    const posted: CompletionPacket[] = [];
    const failure: PacketAuditFetchFailure = {
      code: "den_unavailable",
      message: "Den Core read failed with timeout",
      retryable: true,
    };

    await runPacketAuditWorkflow({
      auditorBinding: makeAuditorBinding(),
      targetPacketRef: makeTargetRef(),
      reader: makeReader(err(failure)),
      poster: capturePoster(posted),
      auditor: new PacketAuditor(),
      auditorSessionId: "session-audit-01",
      auditorProfileId: "packet-auditor",
      now: () => "2026-06-07T10:20:03.000Z",
    });

    expect(posted[0]?.status).toBe("blocked");
    expect(posted[0]?.blocker?.reason).toBe("den_unavailable");
    expect(posted[0]?.blocker?.requires).toBe("dependency");
    expect(posted[0]?.artifacts[0]?.summary).toContain(
      "Den Core read failed",
    );
  });

  it("models malformed packet fetch failures as structured blocked completions", async () => {
    const posted: CompletionPacket[] = [];
    const failure: PacketAuditFetchFailure = {
      code: "malformed_packet",
      message: "Completion packet metadata did not match schema",
      retryable: false,
    };

    await runPacketAuditWorkflow({
      auditorBinding: makeAuditorBinding(),
      targetPacketRef: makeTargetRef(),
      reader: makeReader(err(failure)),
      poster: capturePoster(posted),
      auditor: new PacketAuditor(),
      auditorSessionId: "session-audit-01",
      auditorProfileId: "packet-auditor",
      now: () => "2026-06-07T10:20:04.000Z",
    });

    expect(posted[0]?.status).toBe("blocked");
    expect(posted[0]?.blocker?.reason).toBe("malformed_packet");
    expect(posted[0]?.blocker?.requires).toBe("human");
  });
});
