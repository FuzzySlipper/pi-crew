/**
 * Tests for worker completion monitor — closeout status assessment.
 */

import { describe, it, expect } from "vitest";
import type { WorkerCompletionAssessInput } from "../../workers/worker-completion-monitor.js";
import { WorkerCompletionMonitor } from "../../workers/worker-completion-monitor.js";
import type { GatewayEvent } from "@pi-crew/core";

// ── Fake event bus ─────────────────────────────────────────────

function createFakeEventBus() {
  const events: GatewayEvent[] = [];
  return {
    emit(event: GatewayEvent) {
      events.push(event);
    },
    on() {
      return () => {};
    },
    off() {},
    events,
    lastCloseout() {
      return events
        .filter((e) => e.event === "worker.closeout_assessed")
        .at(-1)?.payload;
    },
  };
}

function createFakeLogger() {
  const warnings: string[] = [];
  return {
    info: () => {},
    warn: (_msg: string, _ctx?: unknown) => {
      warnings.push(_msg);
    },
    error: () => {},
    debug: () => {},
    warnings,
  };
}

function createMonitor() {
  const bus = createFakeEventBus();
  const logger = createFakeLogger();
  const monitor = new WorkerCompletionMonitor({ logger, eventBus: bus });
  return { monitor, bus, logger };
}

// ── Shared fixtures ────────────────────────────────────────────

const baseInput: WorkerCompletionAssessInput = {
  assignmentId: 1292,
  runId: "piw_test_run_001",
  taskId: 2275,
  rawStatus: "completed",
  completionPacket: {
    status: "completed",
    branch: "feat/some-feature",
    head_commit: "abc123def456",
    tests_run: true,
    artifact_kind: "code_change",
  },
  reviewWorkflow: undefined,
  workerRole: "coder",
};

// ── Tests ──────────────────────────────────────────────────────

describe("WorkerCompletionMonitor", () => {
  describe("assessCloseout", () => {
    it("marks running assignment as in_progress", () => {
      const { monitor, bus } = createMonitor();
      const result = monitor.assessCloseout({ ...baseInput, rawStatus: "running" });

      expect(result.closeoutStatus).toBe("in_progress");
      expect(result.readyForReview).toBe(false);
      expect(result.nextAction).toContain("Wait");
      expect(bus.lastCloseout()?.closeoutStatus).toBe("in_progress");
    });

    it("marks pending assignment as in_progress", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({ ...baseInput, rawStatus: "pending" });

      expect(result.closeoutStatus).toBe("in_progress");
    });

    it("marks completed with valid evidence as ready_for_review", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout(baseInput);

      expect(result.closeoutStatus).toBe("ready_for_review");
      expect(result.readyForReview).toBe(true);
      expect(result.evidenceHandles).toContain("branch:feat/some-feature");
      expect(result.evidenceHandles).toContain("commit:abc123def456");
    });

    it("marks completed with missing branch as malformed", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        completionPacket: { status: "completed", head_commit: "abc123", tests_run: true },
      });

      expect(result.closeoutStatus).toBe("malformed");
      expect(result.nextAction).toContain("missing branch");
    });

    it("marks completed with missing head_commit as malformed", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        completionPacket: { status: "completed", branch: "main", tests_run: true },
      });

      expect(result.closeoutStatus).toBe("malformed");
    });

    it("marks completed with no packet as malformed", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        completionPacket: undefined,
      });

      expect(result.closeoutStatus).toBe("malformed");
    });

    it("marks failed with recovery guidance as blocked", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        rawStatus: "failed",
        completionPacket: {
          status: "failed",
          failure_category: "execution_error",
          recovery_guidance: "Re-assign with more context.",
        },
      });

      expect(result.closeoutStatus).toBe("blocked");
      expect(result.nextAction).toContain("Re-assign with more context");
    });

    it("marks failed without recovery guidance as blocked with default", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        rawStatus: "failed",
        completionPacket: { status: "failed" },
      });

      expect(result.closeoutStatus).toBe("blocked");
      expect(result.nextAction).toContain("Investigate failure");
    });

    it("marks completed with open review findings as review_open", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        reviewWorkflow: { roundCount: 1, unresolvedFindings: 2, resolvedFindings: 0 },
      });

      expect(result.closeoutStatus).toBe("review_open");
      expect(result.readyForReview).toBe(false);
      expect(result.nextAction).toContain("2 open review finding");
    });

    it("marks completed with all findings resolved as done", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        reviewWorkflow: { roundCount: 1, unresolvedFindings: 0, resolvedFindings: 3 },
      });

      expect(result.closeoutStatus).toBe("done");
      expect(result.readyForReview).toBe(true);
      expect(result.evidenceHandles).toContain("all_findings_resolved");
    });

    it("marks malformed raw status with recovery guidance", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        rawStatus: "unknown_status",
        completionPacket: {
          status: "unknown",
          recovery_guidance: "Check worker logs.",
        },
      });

      expect(result.closeoutStatus).toBe("malformed");
      expect(result.nextAction).toContain("Check worker logs");
    });

    it("emits worker.closeout_assessed event", () => {
      const { monitor, bus } = createMonitor();
      monitor.assessCloseout(baseInput);

      const evt = bus.lastCloseout();
      expect(evt).toBeDefined();
      expect(evt!.taskId).toBe(2275);
      expect(evt!.assignmentId).toBe(1292);
      expect(evt!.closeoutStatus).toBe("ready_for_review");
    });

    it("includes correct evidence handles", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout(baseInput);

      expect(result.evidenceHandles).toContain("task:2275");
      expect(result.evidenceHandles).toContain("assignment:1292");
      expect(result.evidenceHandles).toContain("run:piw_test_run_001");
    });

    it("includes review handles when review exists", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        reviewWorkflow: { roundCount: 2, unresolvedFindings: 1, resolvedFindings: 1 },
      });

      expect(result.evidenceHandles).toContain("review_rounds:2");
      expect(result.evidenceHandles).toContain("open_findings:1");
    });

    it("marks non-coder completed without review as done", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        workerRole: "reviewer",
      });

      expect(result.closeoutStatus).toBe("done");
      expect(result.nextAction).toContain("No review required");
    });
  });

  describe("formatChannelReport", () => {
    it("includes all handles in report", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout(baseInput);
      const report = monitor.formatChannelReport(result);

      expect(report).toContain("2275");
      expect(report).toContain("1292");
      expect(report).toContain("piw_test_run_001");
      expect(report).toContain("ready_for_review");
    });

    it("does not claim done without evidence", () => {
      const { monitor, logger } = createMonitor();
      const status = {
        assignmentId: 1,
        runId: "r1",
        taskId: 1,
        status: "completed",
        completionPacket: { status: "completed", branch: "main" },
        readyForReview: true,
        closeoutStatus: "done" as const,
        nextAction: "Done.",
        evidenceHandles: ["task:1"],
      };
      const report = monitor.formatChannelReport(status);

      // Warns about missing head_commit when claiming done
      expect(logger.warnings.length).toBeGreaterThan(0);
      expect(report).toContain("⚠️");
    });

    it("shows review state in report", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        reviewWorkflow: { roundCount: 1, unresolvedFindings: 2, resolvedFindings: 0 },
      });
      const report = monitor.formatChannelReport(result);

      expect(report).toContain("1");
      expect(report).toContain("2");
    });

    it("shows blocked status with failure info", () => {
      const { monitor } = createMonitor();
      const result = monitor.assessCloseout({
        ...baseInput,
        rawStatus: "failed",
        completionPacket: {
          status: "failed",
          failure_category: "execution_error",
        },
      });
      const report = monitor.formatChannelReport(result);

      expect(report).toContain("blocked");
      expect(report).toContain("execution_error");
    });
  });
});
