/** Tests for opt-in context diagnostic report generation. */
import { describe, expect, it } from "vitest";
import { createContextDiagnosticReport } from "../../diagnostics/context-diagnostics.js";
import type { DiagnosticEventRecord } from "../../diagnostics/types.js";

const events: DiagnosticEventRecord[] = [
  {
    sequence: 1,
    observedAt: "2026-06-14T00:00:00.000Z",
    event: "tool.called",
    payload: {
      sessionId: "sess-prime-coder",
      toolName: "read_file",
      params: { path: "secret.env" },
    },
  },
  {
    sequence: 2,
    observedAt: "2026-06-14T00:00:01.000Z",
    event: "tool.completed",
    payload: {
      sessionId: "sess-prime-coder",
      toolName: "read_file",
      success: true,
      result: "DATABASE_URL=postgres://user:super-secret@host/db\n".repeat(30),
    },
  },
  {
    sequence: 3,
    observedAt: "2026-06-14T00:00:02.000Z",
    event: "tool.completed",
    payload: {
      sessionId: "sess-prime-coder",
      toolName: "find_relevant_paths",
      success: true,
      result: { content: [{ type: "text", text: "helper summary".repeat(40) }] },
    },
  },
];

describe("createContextDiagnosticReport", () => {
  it("attributes bounded context usage by source category", () => {
    const report = createContextDiagnosticReport({
      sessionId: "sess-prime-coder",
      turnId: "turn-1",
      userMessage: "please inspect the code",
      assistantMessage: "done",
      events,
    });

    expect(report.sessionId).toBe("sess-prime-coder");
    expect(report.totals.estimatedBytes).toBeGreaterThan(0);
    expect(report.categories.map((category) => category.category)).toEqual(
      expect.arrayContaining([
        "user_prompt",
        "assistant_response",
        "tool_input",
        "direct_file_read",
        "delegated_helper_output",
      ]),
    );
    expect(report.topContributors[0]?.estimatedBytes).toBeGreaterThanOrEqual(
      report.topContributors[1]?.estimatedBytes ?? 0,
    );
    expect(report.recommendations).toEqual(
      expect.arrayContaining([expect.stringContaining("helper tools")]),
    );
  });

  it("redacts secret-like content and bounds samples", () => {
    const report = createContextDiagnosticReport({
      sessionId: "sess-prime-coder",
      turnId: "turn-1",
      userMessage: "token=abc123",
      assistantMessage: "done",
      events,
      maxSampleChars: 80,
    });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("token=abc123");
    expect(serialized).toContain("[REDACTED]");
    for (const contributor of report.topContributors) {
      expect(contributor.sample.length).toBeLessThanOrEqual(80);
    }
  });
});
