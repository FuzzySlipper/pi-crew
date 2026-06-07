/** Runtime integration tests for PacketAuditor's Den-backed execution path. */

import { describe, expect, it } from "vitest";
import type {
  CompletionPacket,
  CompletionPostResult,
  Result,
} from "@pi-crew/core";
import { FakeEventBus, FakeLogger, ok } from "@pi-crew/core";
import type { CompletionPoster } from "@pi-crew/tools";
import { PacketAuditor } from "../../workers/packet-auditor.js";
import type {
  PacketAuditFetchFailure,
  PacketCompletionReader,
} from "../../workers/packet-auditor-workflow.js";
import { WorkerRuntime } from "../../workers/worker-runtime.js";
import type { TargetPacketRef } from "../../workers/worker-role-assembly.js";
import {
  FakeAuditRepo,
  FakeSessionManager,
  makeBinding,
  makeFakePool,
  makeRoleMapping,
} from "./worker-runtime-test-fixtures.js";

function makeTargetRef(): TargetPacketRef {
  return {
    projectId: "pi-crew",
    taskId: "1852",
    runId: "piw_target_packet",
  };
}

function makeTargetCompletion(): CompletionPacket {
  return {
    assignmentId: "target-assignment",
    runId: "piw_target_packet",
    taskId: "1852",
    status: "completed",
    artifacts: [{ type: "implementation", ref: "message/1", summary: "ok" }],
    filesTouched: ["pi-core/src/types.ts"],
    toolsUsed: ["post_worker_completion_packet"],
    tokensConsumed: 123,
    durationMs: 456,
    turnCount: 1,
    role: "coder",
    completedAt: "2026-06-07T13:00:00.000Z",
  };
}

class RecordingReader implements PacketCompletionReader {
  readonly refs: TargetPacketRef[] = [];

  getLatestWorkerCompletion(
    ref: TargetPacketRef,
  ): Promise<Result<CompletionPacket, PacketAuditFetchFailure>> {
    this.refs.push(ref);
    return Promise.resolve(ok(makeTargetCompletion()));
  }
}

function makeRecordingPoster(posted: CompletionPacket[]): CompletionPoster {
  return (packet: CompletionPacket): Promise<CompletionPostResult> => {
    posted.push(packet);
    return Promise.resolve({ accepted: true, message: "accepted" });
  };
}

describe("PacketAuditor runtime path", () => {
  it("audits the binding target packet through the configured Den reader", async () => {
    const reader = new RecordingReader();
    const posted: CompletionPacket[] = [];
    const bus = new FakeEventBus();
    const auditRepo = new FakeAuditRepo();
    const runtime = new WorkerRuntime(
      { workerIdentity: "packet-auditor-worker", packetCompletionReader: reader },
      makeRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      bus,
      new FakeLogger(),
      auditRepo,
      makeRecordingPoster(posted),
    );

    const packet = await runtime.executeAssignment(
      makeBinding({
        assignmentId: "auditor-assignment",
        runId: "piw_auditor_run",
        taskId: "2049",
        role: "packet-auditor",
        targetPacketRef: makeTargetRef(),
      }),
      new PacketAuditor(),
    );

    expect(reader.refs).toEqual([makeTargetRef()]);
    expect(posted).toHaveLength(1);
    expect(packet).toBe(posted[0]);
    expect(packet.assignmentId).toBe("auditor-assignment");
    expect(packet.runId).toBe("piw_auditor_run");
    expect(packet.artifacts[0]?.ref).toBe("den-worker-run/piw_target_packet");
    expect(packet.artifacts[1]?.summary).toContain("session=session-1");
    expect(packet.artifacts[1]?.summary).toContain("profile=packet-auditor");
    expect(auditRepo.events.some((event) => event.eventType === "packet.audited")).toBe(true);
    expect(bus.emitted.some((event) => event.event === "completion.posted")).toBe(true);
  });
});
