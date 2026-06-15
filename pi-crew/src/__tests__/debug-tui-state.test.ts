/** Tests for human-navigable direct-debug TUI state and rendering. */
import { describe, expect, it } from "vitest";
import type { DebugSessionSummary } from "../debug-api-client.js";
import { renderDebugTui } from "../debug-tui-render.js";
import {
  actionFromKey,
  createDebugTuiModel,
  reduceDebugTuiModel,
  type DebugTuiAction,
  type DebugTuiModel,
} from "../debug-tui-state.js";

const SESSIONS: readonly DebugSessionSummary[] = [
  session("sess-alpha", "alpha", 3),
  session("sess-prime-coder", "prime-coder", 8),
  session("sess-zed", "zed", 1),
];

describe("debug TUI navigation model", () => {
  it("loads sessions, highlights, and selects by keyboard without typed session ids", () => {
    let model = createDebugTuiModel();
    model = reduceDebugTuiModel(model, { type: "sessionsLoaded", sessions: SESSIONS });

    expect(model.selectedSessionId).toBe("sess-alpha");
    model = applyKey(model, "\x1b[B");
    expect(model.selectedSessionIndex).toBe(1);
    expect(model.selectedSessionId).toBe("sess-alpha");

    model = applyKey(model, "\r");
    expect(model.selectedSessionId).toBe("sess-prime-coder");
    expect(model.refreshRequested).toBe(true);
  });

  it("maps focus, views, scrolling, refresh, and event expansion to keyboard actions", () => {
    let model = reduceDebugTuiModel(createDebugTuiModel("sess-prime-coder"), {
      type: "sessionsLoaded",
      sessions: SESSIONS,
      preferredSessionId: "sess-prime-coder",
    });

    model = applyKey(model, "\t");
    expect(model.focus).toBe("body");
    model = applyKey(model, "e");
    expect(model.view).toBe("events");
    model = reduceDebugTuiModel(model, { type: "eventsLoaded", events: [{ sequence: 1, event: "tool.called" }] });
    model = applyKey(model, "x");
    expect(model.expandedEvent).toBe(true);
    model = applyKey(model, "r");
    expect(model.refreshRequested).toBe(true);
  });

  it("treats slash input as a service turn instead of a local command", () => {
    let model = reduceDebugTuiModel(createDebugTuiModel("sess-prime-coder"), {
      type: "sessionsLoaded",
      sessions: SESSIONS,
      preferredSessionId: "sess-prime-coder",
    });

    for (const key of ["/", "s", "t", "a", "t", "u", "s"]) {
      model = applyKey(model, key);
    }
    model = applyKey(model, "\r");

    const requested = model.submitRequested;
    expect(requested).toBe("/status");
    model = reduceDebugTuiModel(model, { type: "turnStarted", message: requested ?? "" });
    expect(model.transcript.at(-1)).toEqual({ role: "operator", text: "/status" });
  });
});

describe("debug TUI renderer", () => {
  it("renders full-screen panes, controls, selected session, and input", () => {
    let model = reduceDebugTuiModel(createDebugTuiModel("sess-prime-coder"), {
      type: "sessionsLoaded",
      sessions: SESSIONS,
      preferredSessionId: "sess-prime-coder",
    });
    model = reduceDebugTuiModel(model, { type: "insertText", text: "/status" });
    const screen = renderDebugTui(model, { width: 100, height: 28 });

    expect(screen).toContain("direct-debug TUI");
    expect(screen).toContain("sessions");
    expect(screen).toContain("sess-prime-coder");
    expect(screen).toContain("selected session");
    expect(screen).toContain("input");
    expect(screen).toContain("/status");
    expect(screen).toContain("Tab=focus");
  });
});

function applyKey(model: DebugTuiModel, key: string): DebugTuiModel {
  const action: DebugTuiAction | null = actionFromKey(key, model);
  if (action === null) throw new Error(`No action for ${JSON.stringify(key)}`);
  return reduceDebugTuiModel(model, action);
}

function session(sessionId: string, profileId: string, messageCount: number): DebugSessionSummary {
  return {
    sessionId,
    profileId,
    instanceId: `inst-${sessionId}`,
    kind: "full-agent",
    sessionState: "active",
    messageCount,
    recentErrorCount: 0,
    presenceStatus: "active",
    classification: "healthy",
    lastActivityAt: "2026-06-15T00:00:00.000Z",
  };
}
