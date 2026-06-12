import { beforeEach, describe, expect, it } from "vitest";
import { FakeChannelProvider, FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { ChannelContent, LogEntry } from "@pi-crew/core";
import type {
  DelegationCompletedPayload,
  DelegationKilledPayload,
  DelegationSpawnedPayload,
  DelegationTimeoutPayload,
  DelegationToolVisiblePayload,
  DelegationTurnVisiblePayload,
  DelegatedResult,
} from "@pi-crew/core";
import { DenDelegationProjectionExtension } from "../../workers/den-delegation-projection.js";
import type { ServiceExtensionContext } from "../../extension-activator.js";

function createContext(
  overrides: Partial<Pick<ServiceExtensionContext, "eventBus" | "logger">> = {},
): ServiceExtensionContext {
  return {
    eventBus: overrides.eventBus ?? new FakeEventBus(),
    logger: overrides.logger ?? new FakeLogger(),
    config: undefined as unknown as ServiceExtensionContext["config"],
    hookRegistry: undefined as unknown as ServiceExtensionContext["hookRegistry"],
    delegationSessions: undefined as unknown as ServiceExtensionContext["delegationSessions"],
  };
}

function projectionEntries(logger: FakeLogger): Array<Record<string, unknown>> {
  return logger.entries
    .filter((e) => e.level === "info" && e.message.startsWith("delegation.event."))
    .map((e) => (e.context ?? {}) as Record<string, unknown>);
}

function textOf(content: ChannelContent): string {
  if (content.kind === "text") return content.text;
  if (content.kind === "mixed") return content.parts.map(textOf).join("\n");
  return content.altText ?? content.url;
}

function spawnedPayload(overrides: Partial<DelegationSpawnedPayload> = {}): DelegationSpawnedPayload {
  return {
    childSessionId: "child-1",
    lineage: {
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
      childSessionId: "child-1",
      depth: 1,
      chain: ["root-1", "child-1"],
    },
    policyId: "policy-1",
    task: "Analyze the codebase",
    effectiveRuntime: { profileId: "coder-child", provider: "openrouter", model: "claude-sonnet-4" },
    ...overrides,
  };
}

function completedPayload(
  outcome: DelegatedResult["outcome"] = "success",
  overrides: Partial<DelegationCompletedPayload> = {},
): DelegationCompletedPayload {
  const baseResult: DelegatedResult = {
    childSessionId: "child-1",
    outcome,
    policyId: "policy-1",
    summary: "Task completed successfully",
    durationMs: 1500,
    tokensConsumed: 5000,
    turnsUsed: 3,
  };
  return {
    childSessionId: "child-1",
    lineage: {
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
      childSessionId: "child-1",
      depth: 1,
      chain: ["root-1", "child-1"],
    },
    policyId: "policy-1",
    result: baseResult,
    ...overrides,
  };
}

function killedPayload(overrides: Partial<DelegationKilledPayload> = {}): DelegationKilledPayload {
  return {
    childSessionId: "child-1",
    lineage: {
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
      childSessionId: "child-1",
      depth: 1,
      chain: ["root-1", "child-1"],
    },
    policyId: "policy-1",
    reason: "Operator cancelled",
    initiatedBy: "parent",
    ...overrides,
  };
}

function timeoutPayload(overrides: Partial<DelegationTimeoutPayload> = {}): DelegationTimeoutPayload {
  return {
    childSessionId: "child-1",
    lineage: {
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
      childSessionId: "child-1",
      depth: 1,
      chain: ["root-1", "child-1"],
    },
    policyId: "policy-1",
    timeoutMs: 30_000,
    elapsedMs: 30_000,
    ...overrides,
  };
}

function turnVisiblePayload(
  phase: "started" | "completed" | "errored" = "completed",
  overrides: Partial<DelegationTurnVisiblePayload> = {},
): DelegationTurnVisiblePayload {
  return {
    childSessionId: "child-1",
    lineage: {
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
      childSessionId: "child-1",
      depth: 1,
      chain: ["root-1", "child-1"],
    },
    policyId: "policy-1",
    turnNumber: 1,
    phase,
    ...overrides,
  };
}

function toolVisiblePayload(
  phase: "called" | "completed" | "denied" = "completed",
  overrides: Partial<DelegationToolVisiblePayload> = {},
): DelegationToolVisiblePayload {
  return {
    childSessionId: "child-1",
    lineage: {
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
      childSessionId: "child-1",
      depth: 1,
      chain: ["root-1", "child-1"],
    },
    policyId: "policy-1",
    toolName: "read_file",
    toolCallId: "tool-call-1",
    phase,
    ...overrides,
  };
}

describe("DenDelegationProjectionExtension", () => {
  let eventBus: FakeEventBus;
  let logger: FakeLogger;
  let extension: DenDelegationProjectionExtension;

  beforeEach(async () => {
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
    extension = new DenDelegationProjectionExtension({ loggerEnabled: true });
    context = createContext({ eventBus, logger });
    await extension.activate(context);
  });

  let context: ServiceExtensionContext;

  describe("high-signal events (always project)", () => {
    it("projects delegation.spawned events", () => {
      eventBus.emit({ event: "delegation.spawned", payload: spawnedPayload() });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].childSessionId).toBe("child-1");
      expect(entries[0].depth).toBe(1);
    });

    it("projects delegation.completed events with result details", () => {
      eventBus.emit({ event: "delegation.completed", payload: completedPayload() });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].outcome).toBe("success");
      expect(entries[0].tokensConsumed).toBe(5000);
      expect(entries[0].turnsUsed).toBe(3);
    });

    it("projects delegation.completed with failure category for non-success outcomes", () => {
      const result: DelegatedResult = {
        childSessionId: "child-1",
        outcome: "failure",
        policyId: "policy-1",
        summary: "Missing expected artifact",
        failureCategory: "missing_artifact",
        recoveryGuidance: "Re-run with explicit output path",
      };
      eventBus.emit({ event: "delegation.completed", payload: completedPayload("failure", { result }) });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].outcome).toBe("failure");
      expect(entries[0].failureCategory).toBe("missing_artifact");
    });

    it("projects delegation.killed events", () => {
      eventBus.emit({ event: "delegation.killed", payload: killedPayload() });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe("Operator cancelled");
      expect(entries[0].initiatedBy).toBe("parent");
    });

    it("projects delegation.timeout events", () => {
      eventBus.emit({ event: "delegation.timeout", payload: timeoutPayload() });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].timeoutMs).toBe(30_000);
      expect(entries[0].elapsedMs).toBe(30_000);
    });

    it("projects delegation.orphan_detected events", () => {
      eventBus.emit({
        event: "delegation.orphan_detected",
        payload: {
          orphanSessionId: "child-orphan",
          lastKnownParentSessionId: "parent-dead",
          idleDurationMs: 60_000,
          lineage: {
            parentSessionId: "parent-dead",
            rootSessionId: "root-1",
            childSessionId: "child-orphan",
            depth: 2,
            chain: ["root-1", "parent-dead", "child-orphan"],
          },
          policyId: "policy-orphan",
        },
      });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].orphanSessionId).toBe("child-orphan");
    });
  });

  describe("medium-signal events (rate-limited)", () => {
    it("projects delegation.turn_visible events with coalescing", () => {
      eventBus.emit({ event: "delegation.turn_visible", payload: turnVisiblePayload("started") });
      eventBus.emit({
        event: "delegation.turn_visible",
        payload: turnVisiblePayload("completed", { turnNumber: 2 }),
      });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
    });

    it("always projects errored turn events immediately (no rate limit)", () => {
      eventBus.emit({ event: "delegation.turn_visible", payload: turnVisiblePayload("errored") });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].phase).toBe("errored");
    });

    it("projects delegation.tool_visible completion events (not called phase)", () => {
      eventBus.emit({ event: "delegation.tool_visible", payload: toolVisiblePayload("completed") });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].toolName).toBe("read_file");
    });

    it("skips tool called-phase events by default", () => {
      eventBus.emit({ event: "delegation.tool_visible", payload: toolVisiblePayload("called") });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(0);
    });

    it("always projects denied tool events immediately", () => {
      eventBus.emit({
        event: "delegation.tool_visible",
        payload: toolVisiblePayload("denied", { reason: "Policy: tool not allowed" }),
      });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe("Policy: tool not allowed");
    });
  });

  describe("rate limiting with coalesced state", () => {
    it("tracks coalesced turn count across rapid events", () => {
      eventBus.emit({ event: "delegation.turn_visible", payload: turnVisiblePayload("completed", { turnNumber: 1 }) });
      eventBus.emit({ event: "delegation.turn_visible", payload: turnVisiblePayload("completed", { turnNumber: 2 }) });

      const turnState = extension.activeTurnCoalescing.get("child-1");
      expect(turnState).toBeDefined();
      expect(turnState!.turnCount).toBe(2);
    });

    it("tracks coalesced tool counts across rapid events", () => {
      eventBus.emit({ event: "delegation.tool_visible", payload: toolVisiblePayload("completed", { toolName: "read_file" }) });
      eventBus.emit({ event: "delegation.tool_visible", payload: toolVisiblePayload("completed", { toolName: "search_files" }) });
      eventBus.emit({ event: "delegation.tool_visible", payload: toolVisiblePayload("called", { toolName: "read_file" }) });

      const toolState = extension.activeToolCoalescing.get("child-1");
      expect(toolState).toBeDefined();
      expect(toolState!.toolCallCount).toBe(3);
      expect(toolState!.completedCount).toBe(2);
    });
  });

  describe("cleanup on completion events", () => {
    it("clears coalescing state on child completion", () => {
      eventBus.emit({ event: "delegation.turn_visible", payload: turnVisiblePayload("completed") });
      expect(extension.activeTurnCoalescing.has("child-1")).toBe(true);
      eventBus.emit({ event: "delegation.completed", payload: completedPayload() });
      expect(extension.activeTurnCoalescing.has("child-1")).toBe(false);
      expect(extension.activeToolCoalescing.has("child-1")).toBe(false);
    });

    it("clears coalescing state on child kill", () => {
      eventBus.emit({ event: "delegation.tool_visible", payload: toolVisiblePayload("completed") });
      expect(extension.activeToolCoalescing.has("child-1")).toBe(true);

      eventBus.emit({ event: "delegation.killed", payload: killedPayload() });
      expect(extension.activeToolCoalescing.has("child-1")).toBe(false);
    });

    it("clears coalescing state on child timeout", () => {
      eventBus.emit({ event: "delegation.turn_visible", payload: turnVisiblePayload("started") });
      expect(extension.activeTurnCoalescing.has("child-1")).toBe(true);

      eventBus.emit({ event: "delegation.timeout", payload: timeoutPayload() });
      expect(extension.activeTurnCoalescing.has("child-1")).toBe(false);
    });
  });

  describe("channel provider projection", () => {
    it("sends high-signal delegation events to the configured ChannelProvider", async () => {
      const channel = new FakeChannelProvider();
      const ext = new DenDelegationProjectionExtension({
        loggerEnabled: false,
        channelProvider: channel,
        channelId: "den-channel-1",
      });
      const eb = new FakeEventBus();
      const log = new FakeLogger();

      await ext.activate(createContext({ eventBus: eb, logger: log }));
      eb.emit({ event: "delegation.spawned", payload: spawnedPayload() });
      await Promise.resolve();

      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0]?.channelId).toBe("den-channel-1");
      expect(textOf(channel.sentMessages[0]!.content)).toContain(
        "Subagent spawned: depth 1, profile coder-child",
      );
      expect(channel.sentMessages[0]?.content.metadata).toMatchObject({
        eventName: "delegation.spawned",
        childSessionId: "child-1",
        parentSessionId: "parent-1",
        rootSessionId: "root-1",
        depth: 1,
        policyId: "policy-1",
      });
    });

    it("logs projection failures without preventing logger fallback", async () => {
      class FailingChannelProvider extends FakeChannelProvider {
        override sendMessage(): Promise<never> {
          return Promise.reject(new Error("channel down"));
        }
      }

      const ext = new DenDelegationProjectionExtension({
        loggerEnabled: true,
        channelProvider: new FailingChannelProvider(),
        channelId: "den-channel-1",
      });
      const eb = new FakeEventBus();
      const log = new FakeLogger();

      await ext.activate(createContext({ eventBus: eb, logger: log }));
      eb.emit({ event: "delegation.completed", payload: completedPayload() });
      await Promise.resolve();
      await Promise.resolve();

      expect(projectionEntries(log)).toHaveLength(1);
      expect(log.entries.some((entry) => entry.message === "delegation.projection.channel_failed")).toBe(true);
    });
  });

  describe("config and lifecycle", () => {
    it("can activate and deactivate cleanly", async () => {
      const ext = new DenDelegationProjectionExtension();
      const eb = new FakeEventBus();
      const log = new FakeLogger();

      await ext.activate(createContext({ eventBus: eb, logger: log }));
      await ext.deactivate();

      eb.emit({ event: "delegation.spawned", payload: spawnedPayload() });
      expect(projectionEntries(log)).toHaveLength(0);
    });

    it("supports config with projectToolCalledEvents enabled", async () => {
      const ext = new DenDelegationProjectionExtension({
        loggerEnabled: true,
        projectToolCalledEvents: true,
      });
      const eb = new FakeEventBus();
      const log = new FakeLogger();

      await ext.activate(createContext({ eventBus: eb, logger: log }));

      eb.emit({ event: "delegation.tool_visible", payload: toolVisiblePayload("called") });

      const entries = projectionEntries(log);
      expect(entries).toHaveLength(1);
      expect(entries[0].phase).toBe("called");
    });

    it("does not project events when loggerEnabled is false", async () => {
      const ext = new DenDelegationProjectionExtension({ loggerEnabled: false });
      const eb = new FakeEventBus();
      const log = new FakeLogger();

      await ext.activate(createContext({ eventBus: eb, logger: log }));

      eb.emit({ event: "delegation.spawned", payload: spawnedPayload() });
      expect(projectionEntries(log)).toHaveLength(0);
    });
  });

  describe("lineage and correlation in projections", () => {
    it("includes parent/root/chain lineage in spawned events", () => {
      eventBus.emit({
        event: "delegation.spawned",
        payload: spawnedPayload({
          lineage: {
            parentSessionId: "parent-1",
            rootSessionId: "root-1",
            childSessionId: "child-1",
            depth: 1,
            chain: ["root-1", "child-1"],
          },
        }),
      });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(1);
      expect(entries[0].parentSessionId).toBe("parent-1");
      expect(entries[0].rootSessionId).toBe("root-1");
    });

    it("includes multiple child session IDs in parallel children", () => {
      eventBus.emit({
        event: "delegation.spawned",
        payload: spawnedPayload({
          childSessionId: "child-a",
          lineage: {
            parentSessionId: "parent-1",
            rootSessionId: "root-1",
            childSessionId: "child-a",
            depth: 1,
            chain: ["root-1", "child-a"],
          },
        }),
      });
      eventBus.emit({
        event: "delegation.spawned",
        payload: spawnedPayload({
          childSessionId: "child-b",
          lineage: {
            parentSessionId: "parent-1",
            rootSessionId: "root-1",
            childSessionId: "child-b",
            depth: 1,
            chain: ["root-1", "child-b"],
          },
        }),
      });

      const entries = projectionEntries(logger);
      expect(entries).toHaveLength(2);
      expect(entries[0].childSessionId).toBe("child-a");
      expect(entries[1].childSessionId).toBe("child-b");
    });
  });
});
