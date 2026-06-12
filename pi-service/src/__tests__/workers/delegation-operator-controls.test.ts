/**
 * Tests for DelegationOperatorControls.
 *
 * Uses a fake DelegationSessionBridge (no mocks), FakeEventBus, and
 * FakeLogger to verify operator control behavior end-to-end.
 */

import { describe, it, expect } from "vitest";
import {
  FakeEventBus,
  FakeLogger,
  type OperatorControlPolicy,
} from "@pi-crew/core";
import type { DelegationSessionBridge, ServiceSessionView } from "../../../extension-activator.js";
import { DelegationOperatorControls } from "../../workers/delegation-operator-controls.js";

// ── Fake bridge ────────────────────────────────────────────────

interface FakeBridgeState {
  readonly sessions: Map<string, ServiceSessionView>;
  readonly archived: string[];
  readonly killed: string[];
}

function createFakeBridge(initial?: ServiceSessionView[]): {
  bridge: DelegationSessionBridge;
  state: FakeBridgeState;
} {
  const sessions = new Map<string, ServiceSessionView>();
  const archived: string[] = [];
  const killed: string[] = [];

  for (const s of initial ?? []) {
    sessions.set(s.sessionId, s);
  }

  const bridge: DelegationSessionBridge = {
    async getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    async createDelegatedSession() {
      throw new Error("not used in tests");
    },
    async listChildSessions(parentId: string) {
      return [...sessions.values()].filter(
        (s) => s.parentSessionId === parentId,
      );
    },
    async countChildSessions(parentId: string) {
      return [...sessions.values()].filter(
        (s) => s.parentSessionId === parentId,
      ).length;
    },
    async getParentExecutionPolicy() {
      return null;
    },
    async releaseChildSession(id: string, _reason: string) {
      const existing = sessions.get(id);
      if (existing) {
        sessions.set(id, { ...existing, state: "idle" });
      }
    },
    async killChildSession(id: string, _reason: string) {
      killed.push(id);
    },
    async archiveChildSession(id: string, _reason: string) {
      archived.push(id);
      sessions.delete(id);
    },
    async emitVisibilityEvent() {
      // no-op for tests
    },
  };

  return { bridge, state: { sessions, archived, killed } };
}

// ── Test data ──────────────────────────────────────────────────

function makeChild(
  sessionId: string,
  parentId: string,
  state: ServiceSessionView["state"] = "active",
): ServiceSessionView {
  return {
    sessionId,
    profileId: "test-profile",
    kind: "delegated",
    state,
    parentSessionId: parentId,
    rootSessionId: parentId,
    lastActiveAt: new Date().toISOString(),
  };
}

const PERMISSIVE_POLICY: OperatorControlPolicy = {
  allowedActions: ["list_children", "checkpoint", "cancel", "kill", "status"],
  requireReason: true,
};

const RESTRICTIVE_POLICY: OperatorControlPolicy = {
  allowedActions: [],
  requireReason: false,
};

const OPERATOR_ALLOWLIST_POLICY: OperatorControlPolicy = {
  allowedActions: ["list_children", "checkpoint", "cancel", "kill", "status"],
  requireReason: true,
  allowedOperators: ["admin-alice", "admin-bob"],
};

// ── Helpers ────────────────────────────────────────────────────

function createControls(
  policy: OperatorControlPolicy = PERMISSIVE_POLICY,
  initial?: ServiceSessionView[],
) {
  const { bridge, state } = createFakeBridge(initial);
  const eventBus = new FakeEventBus();
  const logger = new FakeLogger();
  const controls = new DelegationOperatorControls({
    bridge,
    eventBus,
    logger,
    policy,
  });
  return { controls, eventBus, logger, state };
}

// ── Tests ──────────────────────────────────────────────────────

describe("DelegationOperatorControls", () => {
  // ── listChildren ───────────────────────────────────────────

  describe("listChildren", () => {
    it("returns active delegated children for a parent", async () => {
      const child1 = makeChild("child-1", "parent-1");
      const child2 = makeChild("child-2", "parent-1");
      const other = makeChild("child-other", "parent-2");

      const { controls, eventBus } = createControls(PERMISSIVE_POLICY, [
        child1,
        child2,
        other,
      ]);

      const result = await controls.listChildren("parent-1", "admin");

      expect(result.accepted).toBe(true);
      expect(result.action).toBe("list_children");
      expect(result.children).toHaveLength(2);
      expect(result.children?.map((c: { sessionId: string }) => c.sessionId).sort()).toEqual(
        ["child-1", "child-2"],
      );

      // Both requested and completed events emitted
      const requested = eventBus.emitted.filter(
        (e) => e.event === "operator.control_requested",
      );
      const completed = eventBus.emitted.filter(
        (e) => e.event === "operator.control_completed",
      );
      expect(requested).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(requested[0]!.payload.action).toBe("list_children");
      expect(completed[0]!.payload.accepted).toBe(true);
    });

    it("returns empty list when no children exist", async () => {
      const { controls } = createControls(PERMISSIVE_POLICY);
      const result = await controls.listChildren("parent-none", "admin");

      expect(result.accepted).toBe(true);
      expect(result.children).toHaveLength(0);
    });
  });

  // ── checkpoint ─────────────────────────────────────────────

  describe("checkpoint", () => {
    it("returns current child state", async () => {
      const child = makeChild("child-1", "parent-1", "active");
      const { controls, eventBus } = createControls(PERMISSIVE_POLICY, [child]);

      const result = await controls.checkpoint("child-1", "admin");

      expect(result.accepted).toBe(true);
      expect(result.action).toBe("checkpoint");
      expect(result.childSessionId).toBe("child-1");
      expect(result.checkpoint).toBeDefined();
      expect(result.checkpoint?.childSessionId).toBe("child-1");
      expect(result.checkpoint?.state).toBe("active");

      // Events emitted
      const completed = eventBus.emitted.filter(
        (e) => e.event === "operator.control_completed",
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]!.payload.accepted).toBe(true);
    });

    it("rejects when child session not found", async () => {
      const { controls } = createControls(PERMISSIVE_POLICY);
      const result = await controls.checkpoint("nonexistent", "admin");

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("child session not found");
    });
  });

  // ── cancelChild ────────────────────────────────────────────

  describe("cancelChild", () => {
    it("cancels child, emits events, archives session", async () => {
      const child = makeChild("child-1", "parent-1");
      const { controls, eventBus, state } = createControls(PERMISSIVE_POLICY, [
        child,
      ]);

      const result = await controls.cancelChild(
        "child-1",
        "admin",
        "task no longer needed",
      );

      expect(result.accepted).toBe(true);
      expect(result.action).toBe("cancel");
      expect(result.childSessionId).toBe("child-1");
      expect(result.reason).toBe("task no longer needed");

      // Session should be archived
      expect(state.archived).toContain("child-1");

      // Both requested and completed events
      const requested = eventBus.emitted.filter(
        (e) => e.event === "operator.control_requested",
      );
      const completed = eventBus.emitted.filter(
        (e) => e.event === "operator.control_completed",
      );
      expect(requested).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(requested[0]!.payload.reason).toBe("task no longer needed");
      expect(completed[0]!.payload.accepted).toBe(true);
    });
  });

  // ── killChild ──────────────────────────────────────────────

  describe("killChild", () => {
    it("force kills child, emits events, archives session", async () => {
      const child = makeChild("child-1", "parent-1");
      const { controls, eventBus, state } = createControls(PERMISSIVE_POLICY, [
        child,
      ]);

      const result = await controls.killChild(
        "child-1",
        "admin",
        "unresponsive session",
      );

      expect(result.accepted).toBe(true);
      expect(result.action).toBe("kill");
      expect(result.childSessionId).toBe("child-1");
      expect(result.reason).toBe("unresponsive session");

      // Session should be killed then archived
      expect(state.killed).toContain("child-1");
      expect(state.archived).toContain("child-1");

      // Both requested and completed events
      const requested = eventBus.emitted.filter(
        (e) => e.event === "operator.control_requested",
      );
      const completed = eventBus.emitted.filter(
        (e) => e.event === "operator.control_completed",
      );
      expect(requested).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(completed[0]!.payload.accepted).toBe(true);
    });
  });

  // ── Authorization ──────────────────────────────────────────

  describe("authorization", () => {
    it("rejects unauthorized operator", async () => {
      const { controls } = createControls(OPERATOR_ALLOWLIST_POLICY);
      const result = await controls.listChildren("parent-1", "unknown-user");

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("not in allowed operators");
    });

    it("rejects unknown action when policy blocks it", async () => {
      const { controls } = createControls(RESTRICTIVE_POLICY);
      const result = await controls.listChildren("parent-1", "admin");

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("not in allowed actions");
    });

    it("rejects missing reason when requireReason is true", async () => {
      const child = makeChild("child-1", "parent-1");
      // Using a policy that requires reason but testing with empty reason
      const noReasonPolicy: OperatorControlPolicy = {
        allowedActions: ["cancel", "kill"],
        requireReason: true,
      };
      const { controls } = createControls(noReasonPolicy, [child]);

      // cancelChild with empty reason
      const result = await controls.cancelChild("child-1", "admin", "");
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("reason required");
    });

    it("allows authorized operator from allowlist", async () => {
      const child = makeChild("child-1", "parent-1");
      const { controls } = createControls(OPERATOR_ALLOWLIST_POLICY, [child]);

      const result = await controls.cancelChild(
        "child-1",
        "admin-alice",
        "legitimate reason",
      );
      expect(result.accepted).toBe(true);
    });
  });

  // ── Policy ─────────────────────────────────────────────────

  describe("policy", () => {
    it("empty allowedActions blocks everything", async () => {
      const { controls } = createControls(RESTRICTIVE_POLICY);

      const listResult = await controls.listChildren("parent-1", "admin");
      expect(listResult.accepted).toBe(false);

      const checkpointResult = await controls.checkpoint("child-1", "admin");
      expect(checkpointResult.accepted).toBe(false);

      const cancelResult = await controls.cancelChild(
        "child-1",
        "admin",
        "reason",
      );
      expect(cancelResult.accepted).toBe(false);

      const killResult = await controls.killChild("child-1", "admin", "reason");
      expect(killResult.accepted).toBe(false);
    });

    it("still emits events even when rejected", async () => {
      const { controls, eventBus } = createControls(RESTRICTIVE_POLICY);

      await controls.listChildren("parent-1", "admin");

      const requested = eventBus.emitted.filter(
        (e) => e.event === "operator.control_requested",
      );
      const completed = eventBus.emitted.filter(
        (e) => e.event === "operator.control_completed",
      );

      // Requested always emitted; completed emitted with accepted=false
      expect(requested).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(completed[0]!.payload.accepted).toBe(false);
      expect(completed[0]!.payload.rejectionReason).toBeDefined();
    });
  });

  // ── status ─────────────────────────────────────────────────

  describe("status", () => {
    it("returns policy status information", async () => {
      const { controls, eventBus } = createControls(PERMISSIVE_POLICY);

      const result = await controls.status("admin", "corr-123");

      expect(result.accepted).toBe(true);
      expect(result.action).toBe("status");
      expect(result.reason).toContain("5 actions allowed");

      // Check correlation is passed through
      const requested = eventBus.emitted.find(
        (e) => e.event === "operator.control_requested",
      );
      expect(requested?.payload.correlation).toBe("corr-123");
    });
  });
});
