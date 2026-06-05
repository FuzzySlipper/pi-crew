/**
 * Tests for post_structured_completion tool.
 *
 * @module pi-tools/__tests__/post-structured-completion.test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import {
  validateCompletionPacket,
  postStructuredCompletion,
  buildCompletionPacket,
} from "../post-structured-completion.js";

const validPacket = {
  assignmentId: "42",
  runId: "run-1",
  taskId: "1867",
  status: "completed" as const,
  role: "coder",
  artifacts: [
    { type: "pr", ref: "https://github.com/example/pr/1", summary: "PR #1" },
  ],
  filesTouched: ["src/foo.ts"],
  toolsUsed: ["read_file", "write_file"],
  tokensConsumed: 45000,
  durationMs: 120000,
  turnCount: 5,
  completedAt: new Date().toISOString(),
};

describe("validateCompletionPacket", () => {
  it("accepts a valid completion packet", () => {
    const result = validateCompletionPacket(validPacket);
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it("reports missing assignmentId", () => {
    const result = validateCompletionPacket({
      ...validPacket,
      assignmentId: "",
    });
    expect(result.missing).toContain("assignmentId");
  });

  it("reports missing runId", () => {
    const result = validateCompletionPacket({ ...validPacket, runId: "" });
    expect(result.missing).toContain("runId");
  });

  it("reports missing taskId", () => {
    const result = validateCompletionPacket({ ...validPacket, taskId: "" });
    expect(result.missing).toContain("taskId");
  });

  it("reports missing role", () => {
    const result = validateCompletionPacket({ ...validPacket, role: "" });
    expect(result.missing).toContain("role");
  });

  it("reports invalid status", () => {
    const result = validateCompletionPacket({
      ...validPacket,
      status: "invalid_status" as typeof validPacket.status,
    });
    expect(result.invalid.length).toBeGreaterThan(0);
    expect(result.invalid[0]).toContain("invalid_status");
  });

  it("reports missing artifacts", () => {
    const result = validateCompletionPacket({
      ...validPacket,
      artifacts: [],
    });
    expect(result.missing).toContain(
      "artifacts (at least one artifact required)",
    );
  });

  it("requires blocker when status is blocked", () => {
    const result = validateCompletionPacket({
      ...validPacket,
      status: "blocked",
      blocker: undefined,
    });
    expect(result.missing).toContain(
      "blocker (required when status is 'blocked')",
    );
  });

  it("accepts blocked status with blocker", () => {
    const result = validateCompletionPacket({
      ...validPacket,
      status: "blocked",
      blocker: {
        reason: "Waiting for review",
        requires: "review",
        details: "Needs architect sign-off",
      },
    });
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
  });
});

describe("postStructuredCompletion", () => {
  let eventBus: FakeEventBus;
  let logger: FakeLogger;

  beforeEach(() => {
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
  });

  it("calls the poster and returns the result", async () => {
    const poster = vi.fn<() => Promise<{ accepted: boolean; message: string }>>().mockResolvedValue({
      accepted: true,
      message: "Packet accepted",
    });

    const result = await postStructuredCompletion(
      validPacket,
      poster,
      eventBus,
    );

    expect(result.accepted).toBe(true);
    expect(poster).toHaveBeenCalledWith(validPacket);
  });

  it("emits completion.posted event on success", async () => {
    const poster = vi.fn<() => Promise<{ accepted: boolean; message: string }>>().mockResolvedValue({
      accepted: true,
      message: "ok",
    });

    await postStructuredCompletion(validPacket, poster, eventBus);

    const events = eventBus.emitted.filter(
      (e) => e.event === "completion.posted",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.payload).toMatchObject({
      assignmentId: "42",
      runId: "run-1",
      taskId: "1867",
      status: "completed",
      accepted: true,
    });
  });

  it("throws on invalid packet", async () => {
    const poster = vi.fn<() => Promise<{ accepted: boolean; message: string }>>().mockResolvedValue({
      accepted: true,
      message: "ok",
    });

    await expect(
      postStructuredCompletion(
        { ...validPacket, assignmentId: "" },
        poster,
        eventBus,
        logger,
      ),
    ).rejects.toThrow("Invalid completion packet");
  });

  it("propagates poster errors", async () => {
    const poster = vi.fn<() => Promise<{ accepted: boolean; message: string }>>().mockRejectedValue(new Error("Network error"));

    await expect(
      postStructuredCompletion(validPacket, poster, eventBus, logger),
    ).rejects.toThrow("Network error");
  });
});

describe("buildCompletionPacket", () => {
  it("builds a packet with required fields", () => {
    const packet = buildCompletionPacket({
      assignmentId: "42",
      runId: "run-1",
      taskId: "1867",
      status: "completed",
      role: "coder",
      artifacts: [{ type: "pr", ref: "abc123", summary: "PR" }],
    });

    expect(packet.assignmentId).toBe("42");
    expect(packet.runId).toBe("run-1");
    expect(packet.taskId).toBe("1867");
    expect(packet.status).toBe("completed");
    expect(packet.role).toBe("coder");
    expect(packet.artifacts).toHaveLength(1);
    expect(packet.filesTouched).toEqual([]);
    expect(packet.toolsUsed).toEqual([]);
    expect(packet.tokensConsumed).toBe(0);
    expect(packet.durationMs).toBe(0);
    expect(packet.turnCount).toBe(0);
    expect(packet.blocker).toBeUndefined();
    expect(packet.completedAt).toBeTruthy();
  });

  it("includes optional fields when provided", () => {
    const packet = buildCompletionPacket({
      assignmentId: "42",
      runId: "run-1",
      taskId: "1867",
      status: "blocked",
      role: "coder",
      artifacts: [],
      filesTouched: ["src/a.ts"],
      toolsUsed: ["read_file"],
      tokensConsumed: 1000,
      durationMs: 5000,
      turnCount: 2,
      blocker: {
        reason: "Need review",
        requires: "review",
        details: "Blocked on PR #1",
      },
    });

    expect(packet.filesTouched).toEqual(["src/a.ts"]);
    expect(packet.toolsUsed).toEqual(["read_file"]);
    expect(packet.tokensConsumed).toBe(1000);
    expect(packet.blocker?.reason).toBe("Need review");
  });
});
