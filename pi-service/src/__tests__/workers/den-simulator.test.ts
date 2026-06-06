/**
 * Unit tests for DenSimulator — faithful Den Core simulation.
 *
 * @module pi-service/__tests__/workers/den-simulator
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DenSimulator } from "../../workers/den-simulator.js";
import type { CompletionPacket } from "@pi-crew/core";

function makeValidPacket(
  overrides?: Partial<CompletionPacket>,
): CompletionPacket {
  return {
    assignmentId: "296",
    runId: "piw_test",
    taskId: "1864",
    status: "completed",
    artifacts: [
      {
        type: "implementation_packet",
        ref: "commit/abc",
        summary: "Test",
      },
    ],
    filesTouched: ["src/foo.ts"],
    toolsUsed: ["write_file"],
    tokensConsumed: 1000,
    durationMs: 5000,
    turnCount: 1,
    role: "coder",
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("DenSimulator", () => {
  let sim: DenSimulator;

  beforeEach(() => {
    sim = new DenSimulator();
  });

  // ── Assignment creation ───────────────────────────────────

  it("creates an assignment in pending state", () => {
    const a = sim.createAssignment({
      assignmentId: "296",
      taskId: "1864",
      runId: "piw_test",
      role: "packet-auditor",
    });

    expect(a.assignmentId).toBe("296");
    expect(a.state).toBe("pending");
    expect(a.claimedBy).toBeNull();
    expect(a.claimedAt).toBeNull();
    expect(a.completionPacket).toBeNull();
    expect(a.transitions.length).toBe(1);
  });

  it("tracks assignments in the listing", () => {
    sim.createAssignment({
      assignmentId: "100",
      taskId: "10",
      runId: "run1",
      role: "coder",
    });
    sim.createAssignment({
      assignmentId: "200",
      taskId: "20",
      runId: "run2",
      role: "reviewer",
    });

    expect(sim.listAssignments().length).toBe(2);
    expect(sim.countByState("pending")).toBe(2);
  });

  // ── Claim lifecycle ───────────────────────────────────────

  it("claims a pending assignment", () => {
    sim.createAssignment({
      assignmentId: "300",
      taskId: "30",
      runId: "run3",
      role: "coder",
    });

    const claimed = sim.claimAssignment("300", "pi-worker-1");

    expect(claimed.state).toBe("claimed");
    expect(claimed.claimedBy).toBe("pi-worker-1");
    expect(claimed.claimedAt).not.toBeNull();
    expect(claimed.transitions.length).toBe(2);
  });

  it("throws when claiming an already-claimed assignment", () => {
    sim.createAssignment({
      assignmentId: "300",
      taskId: "30",
      runId: "run3",
      role: "coder",
    });
    sim.claimAssignment("300", "worker-1");

    expect(() =>
      sim.claimAssignment("300", "worker-2"),
    ).toThrow("Cannot claim");
  });

  it("throws when claiming a non-existent assignment", () => {
    expect(() =>
      sim.claimAssignment("nonexistent", "worker-1"),
    ).toThrow("not found");
  });

  // ── Complete lifecycle ────────────────────────────────────

  it("accepts a valid completion packet", () => {
    sim.createAssignment({
      assignmentId: "400",
      taskId: "40",
      runId: "run4",
      role: "coder",
    });
    sim.claimAssignment("400", "worker-1");

    const result = sim.postCompletion(
      "400",
      makeValidPacket({ assignmentId: "400" }),
    );

    expect(result.accepted).toBe(true);
    const a = sim.getAssignment("400");
    expect(a?.state).toBe("completed");
    expect(a?.completionPacket).not.toBeNull();
    expect(a?.transitions.length).toBe(3);
  });

  it("rejects completion for unclaimed assignment", () => {
    sim.createAssignment({
      assignmentId: "500",
      taskId: "50",
      runId: "run5",
      role: "coder",
    });

    const result = sim.postCompletion(
      "500",
      makeValidPacket({ assignmentId: "500" }),
    );

    expect(result.accepted).toBe(false);
    expect(result.message).toContain("current state is pending");
  });

  it("rejects completion with mismatched assignmentId", () => {
    sim.createAssignment({
      assignmentId: "600",
      taskId: "60",
      runId: "run6",
      role: "coder",
    });
    sim.claimAssignment("600", "worker-1");

    const result = sim.postCompletion(
      "600",
      makeValidPacket({ assignmentId: "999" }),
    );

    expect(result.accepted).toBe(false);
    expect(result.message).toContain("does not match");
  });

  // ── Release lifecycle ─────────────────────────────────────

  it("releases a completed assignment", () => {
    sim.createAssignment({
      assignmentId: "700",
      taskId: "70",
      runId: "run7",
      role: "coder",
    });
    sim.claimAssignment("700", "worker-1");
    sim.postCompletion(
      "700",
      makeValidPacket({ assignmentId: "700" }),
    );

    const released = sim.releaseAssignment("700", "completed");

    expect(released.state).toBe("released");
    expect(released.releasedAt).not.toBeNull();
    expect(released.transitions.length).toBe(4);
  });

  it("throws when releasing an uncompleted assignment", () => {
    sim.createAssignment({
      assignmentId: "800",
      taskId: "80",
      runId: "run8",
      role: "coder",
    });

    expect(() =>
      sim.releaseAssignment("800", "completed"),
    ).toThrow("Cannot release");
  });

  // ── Full lifecycle ────────────────────────────────────────

  it("completes the full pending→claimed→completed→released cycle", () => {
    sim.createAssignment({
      assignmentId: "900",
      taskId: "90",
      runId: "run9",
      role: "packet-auditor",
    });

    // pending
    expect(sim.countByState("pending")).toBe(1);

    // claim
    sim.claimAssignment("900", "pi-worker");
    expect(sim.countByState("claimed")).toBe(1);

    // complete
    const result = sim.postCompletion(
      "900",
      makeValidPacket({ assignmentId: "900" }),
    );
    expect(result.accepted).toBe(true);
    expect(sim.countByState("completed")).toBe(1);

    // release
    sim.releaseAssignment("900", "done");
    expect(sim.countByState("released")).toBe(1);

    // Audit trail
    const a = sim.getAssignment("900");
    expect(a?.transitions).toEqual([
      expect.stringContaining("created"),
      expect.stringContaining("claimed by pi-worker"),
      expect.stringContaining("completion posted"),
      expect.stringContaining("released"),
    ]);
  });

  // ── Reset ─────────────────────────────────────────────────

  it("reset clears all assignments", () => {
    sim.createAssignment({
      assignmentId: "100",
      taskId: "10",
      runId: "run1",
      role: "coder",
    });
    sim.reset();

    expect(sim.listAssignments().length).toBe(0);
  });

  // ── Validation ────────────────────────────────────────────

  it("validates required fields on a packet", () => {
    const missing = sim.validatePacketRequiredFields({
      assignmentId: "x",
      runId: "y",
      // missing taskId, status, artifacts, tokensConsumed
    });

    expect(missing).toContain("taskId");
    expect(missing).toContain("status");
    expect(missing).toContain("artifacts");
    expect(missing).toContain("tokensConsumed");
  });

  it("returns no missing fields for a valid packet", () => {
    const missing = sim.validatePacketRequiredFields({
      assignmentId: "x",
      runId: "y",
      taskId: "z",
      status: "completed",
      artifacts: [{ type: "test", ref: "ref", summary: "s" }],
      tokensConsumed: 100,
    });

    expect(missing.length).toBe(0);
  });
});
