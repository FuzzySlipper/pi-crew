/** Tests for WorkerRuntime AgentSupervisor wiring. */

import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { WorkerRuntime, type WorkerExecutor } from "../../workers/worker-runtime.js";
import type { AgentLike } from "../../workers/agent-supervisor.js";
import {
  FakeAuditRepo,
  FakeSessionManager,
  makeAcceptingPoster,
  makeBinding,
  makeFakePool,
  makeRoleMapping,
} from "./worker-runtime-test-fixtures.js";

type EventListener = (
  event: AgentEvent,
  signal: AbortSignal,
) => Promise<void> | void;

class FakeAgent implements AgentLike {
  readonly #listeners: EventListener[] = [];
  readonly #signal = new AbortController().signal;
  readonly state = {
    tools: [
      { name: "read_file" },
      { name: "context_status" },
      { name: "post_structured_completion" },
    ],
  };

  subscribe(listener: EventListener): () => void {
    this.#listeners.push(listener);
    return () => {
      const index = this.#listeners.indexOf(listener);
      if (index >= 0) this.#listeners.splice(index, 1);
    };
  }

  async feed(...events: AgentEvent[]): Promise<void> {
    for (const event of events) {
      for (const listener of this.#listeners) {
        await listener(event, this.#signal);
      }
    }
  }
}

function turnStart(): AgentEvent {
  return { type: "turn_start" };
}

function turnEnd(): AgentEvent {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
      timestamp: Date.now(),
    },
    toolResults: [],
  } as unknown as AgentEvent;
}

function messageEnd(tokens: number): AgentEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "end_turn",
      timestamp: Date.now(),
    },
  } as unknown as AgentEvent;
}

function toolStart(id: string, name: string): AgentEvent {
  return { type: "tool_execution_start", toolCallId: id, toolName: name, args: {} };
}

function toolEnd(id: string, name: string): AgentEvent {
  return {
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name,
    result: "ok",
    isError: false,
  };
}

describe("WorkerRuntime AgentSupervisor wiring", () => {
  it("lets executors bridge Agent events with Den correlation and packet turn count", async () => {
    const bus = new FakeEventBus();
    const agent = new FakeAgent();
    const executor: WorkerExecutor = {
      async execute(context) {
        const supervisor = context.createAgentSupervisor(agent);
        supervisor.start();
        await agent.feed(
          turnStart(),
          toolStart("tc-1", "read_file"),
          toolEnd("tc-1", "read_file"),
          turnEnd(),
          turnStart(),
          turnEnd(),
        );
        supervisor.stop();
        return {
          status: "completed",
          artifacts: [],
          filesTouched: [],
          toolsUsed: ["read_file"],
          tokensConsumed: 0,
          summary: "agent-supervised",
          turnCount: supervisor.turnCount,
        };
      },
    };

    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      makeRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      bus,
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    const packet = await runtime.executeAssignment(makeBinding(), executor);

    expect(packet.turnCount).toBe(2);
    const turnStarted = bus.emitted.filter((event) => event.event === "turn.started");
    expect(turnStarted).toHaveLength(2);
    expect(turnStarted[0]?.payload.assignmentId).toBe("101");
    expect(turnStarted[0]?.payload.runId).toBe("piw_test_run");
    expect(turnStarted[0]?.payload.taskId).toBe("2066");
    expect(turnStarted[0]?.payload.profileId).toBe("spawned-coder");

    const toolCalled = bus.emitted.find((event) => event.event === "tool.called");
    expect(toolCalled?.payload.toolName).toBe("read_file");
    expect(toolCalled?.payload.assignmentId).toBe("101");
  });

  it("shares token tracker with context_status and drains real Agent tools", async () => {
    const bus = new FakeEventBus();
    const agent = new FakeAgent();
    const executor: WorkerExecutor = {
      async execute(context) {
        const supervisor = context.createAgentSupervisor(agent);
        supervisor.start();
        await agent.feed(turnStart(), messageEnd(170_000), turnEnd());
        supervisor.stop();

        const snapshot = context.contextStatus();
        expect(snapshot.tokensUsed).toBe(170_000);
        expect(context.contextUsageTracker.tokensUsed).toBe(170_000);
        expect(context.drainModeManager.isActive).toBe(true);
        expect(agent.state.tools.map((tool) => tool.name)).toEqual([
          "context_status",
          "post_structured_completion",
        ]);

        return {
          status: "completed",
          artifacts: [],
          filesTouched: [],
          toolsUsed: agent.state.tools.map((tool) => tool.name),
          tokensConsumed: snapshot.tokensUsed,
          summary: "token-aware",
          turnCount: supervisor.turnCount,
        };
      },
    };

    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      makeRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      bus,
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    const packet = await runtime.executeAssignment(makeBinding(), executor);
    expect(packet.tokensConsumed).toBe(170_000);
    expect(bus.emitted.some((event) => event.event === "drain.activated")).toBe(true);
  });

  it("does not emit synthetic turn.started when executor does not use an Agent", async () => {
    const bus = new FakeEventBus();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      makeRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      bus,
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    const packet = await runtime.executeAssignment(makeBinding(), {
      execute: () =>
        Promise.resolve({
          status: "completed",
          artifacts: [],
          filesTouched: [],
          toolsUsed: [],
          tokensConsumed: 0,
          summary: "no-agent",
        }),
    });

    expect(packet.turnCount).toBe(0);
    expect(bus.emitted.some((event) => event.event === "turn.started")).toBe(false);
  });
});
