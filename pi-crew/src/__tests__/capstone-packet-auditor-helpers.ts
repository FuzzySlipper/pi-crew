/** PacketAuditor capstone helpers for Den-backed target packet refs. */

import type { CompletionPacket, Result } from "@pi-crew/core";
import type {
  PacketAuditFetchFailure,
  PacketCompletionReader,
  WorkerBinding,
} from "@pi-crew/service";

export function makeTargetPacketRef(
  runId: string,
): WorkerBinding["targetPacketRef"] {
  return {
    projectId: "pi-crew",
    taskId: "target-task",
    runId,
  };
}

export function makeTargetCompletionPacket(runId: string): CompletionPacket {
  const now = new Date().toISOString();
  return {
    assignmentId: "target-assignment",
    runId,
    taskId: "target-task",
    status: "completed",
    artifacts: [
      { type: "implementation_packet", ref: "commit/target", summary: "ok" },
    ],
    filesTouched: ["src/target.ts"],
    toolsUsed: ["post_worker_completion_packet"],
    tokensConsumed: 100,
    durationMs: 1000,
    turnCount: 1,
    role: "coder",
    completedAt: now,
  };
}

export function makePacketReader(
  result: Result<CompletionPacket, PacketAuditFetchFailure>,
): PacketCompletionReader {
  return {
    getLatestWorkerCompletion() {
      return Promise.resolve(result);
    },
  };
}
