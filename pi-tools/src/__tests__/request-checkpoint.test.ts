/** Tests for request_checkpoint tool. */

import { describe, expect, it, vi } from "vitest";
import {
  createCheckpointState,
  requestCheckpointTool,
  type CheckpointPacket,
} from "../request-checkpoint.js";

describe("requestCheckpointTool", () => {
  it("posts a checkpoint packet and marks runtime state requested", async () => {
    const state = createCheckpointState();
    const poster = vi.fn<(packet: CheckpointPacket) => Promise<{ accepted: boolean; checkpointId: string }>>()
      .mockResolvedValue({ accepted: true, checkpointId: "cp-42" });
    const tool = requestCheckpointTool({
      assignmentId: "101",
      runId: "piw_test_run",
      taskId: "2066",
      projectId: "pi-crew",
      role: "coder",
      state,
      poster,
    });

    const result = await tool.execute("call-checkpoint", {
      reason: "Need orchestrator review before continuing",
    });

    expect(poster).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: "101",
        runId: "piw_test_run",
        reason: "Need orchestrator review before continuing",
      }),
    );
    expect(state.isCheckpointRequested).toBe(true);
    expect(state.currentRequest?.checkpointId).toBe("cp-42");
    expect(result.details).toMatchObject({ accepted: true, checkpointId: "cp-42" });
    expect(result.content[0]?.type).toBe("text");
  });

  it("does not mark checkpoint requested when Den rejects the packet", async () => {
    const state = createCheckpointState();
    const tool = requestCheckpointTool({
      assignmentId: "101",
      runId: "piw_test_run",
      taskId: "2066",
      projectId: "pi-crew",
      role: "coder",
      state,
      poster: () => Promise.resolve({ accepted: false, message: "rejected" }),
    });

    const result = await tool.execute("call-checkpoint", { reason: "bad checkpoint" });

    expect(state.isCheckpointRequested).toBe(false);
    expect(result.details).toMatchObject({ accepted: false });
  });
});
