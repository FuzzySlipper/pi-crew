/** Checkpoint protocol tests for supervised WorkerRuntime Agents. */

import { describe, expect, it, vi } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { CheckpointPacket } from "@pi-crew/tools";
import { AgentRuntimeRegistry } from "../../workers/agent-runtime-registry.js";
import type { SteerableAgent } from "../../workers/agent-supervisor.js";
import { WorkerRuntime, type WorkerExecutor } from "../../workers/worker-runtime.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "../../workers/guarded-tool-types.js";
import {
  FakeAuditRepo,
  FakeSessionManager,
  makeAcceptingPoster,
  makeBinding,
  makeFakePool,
  makeRoleMapping,
} from "./worker-runtime-test-fixtures.js";

class FakeCheckpointAgent implements SteerableAgent {
  readonly steer = vi.fn((message: AgentMessage) => { void message; });
  readonly followUp = vi.fn((message: AgentMessage) => { void message; });
  readonly hasQueuedMessages = vi.fn(() => false);
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  readonly state: { tools: AgentTool[] } = { tools: [] };

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    void listener;
    return () => undefined;
  }

  async requestCheckpoint(reason: string): Promise<AgentToolResult> {
    const tool = this.state.tools.find((candidate) => candidate.name === "request_checkpoint");
    if (tool === undefined) throw new Error("request_checkpoint tool missing");
    return tool.execute("checkpoint-call", { reason });
  }

  async finishToolCall(result: AgentToolResult): Promise<AfterToolCallResult | undefined> {
    const hookContext: AfterToolCallContext = {
      toolCall: {
        type: "function",
        id: "checkpoint-call",
        name: "request_checkpoint",
        input: {},
      },
      args: {},
      result,
      isError: false,
    };
    return this.afterToolCall?.(hookContext);
  }
}

function makeRuntime(
  bus: FakeEventBus,
  registry: AgentRuntimeRegistry,
  checkpointPoster: (packet: CheckpointPacket) => Promise<{ accepted: boolean; checkpointId?: string }>,
): WorkerRuntime {
  return new WorkerRuntime(
    { workerIdentity: "test-worker", agentRuntimeRegistry: registry, checkpointPoster },
    makeRoleMapping(),
    new FakeSessionManager(),
    makeFakePool(),
    bus,
    new FakeLogger(),
    new FakeAuditRepo(),
    makeAcceptingPoster(),
  );
}

describe("WorkerRuntime checkpoint protocol", () => {
  it("installs request_checkpoint and terminates the tool batch after waiting event", async () => {
    const bus = new FakeEventBus();
    const registry = new AgentRuntimeRegistry();
    const checkpointPoster = vi.fn<(packet: CheckpointPacket) => Promise<{ accepted: boolean; checkpointId: string }>>()
      .mockResolvedValue({ accepted: true, checkpointId: "cp-2070" });
    const agent = new FakeCheckpointAgent();
    const executor: WorkerExecutor = {
      async execute(context) {
        const supervisor = context.createAgentSupervisor(agent);
        supervisor.start();

        expect(agent.state.tools.map((tool) => tool.name)).toContain("request_checkpoint");
        const toolResult = await agent.requestCheckpoint("Need planner decision");
        const afterResult = await agent.finishToolCall(toolResult);

        expect(afterResult?.terminate).toBe(true);
        expect(supervisor.checkpointPhase).toBe("checkpoint_waiting");

        const waiting = bus.emitted.find((event) => event.event === "checkpoint.waiting");
        expect(waiting?.payload).toMatchObject({
          assignmentId: "101",
          runId: "piw_test_run",
          taskId: "2066",
          reason: "Need planner decision",
          checkpointId: "cp-2070",
        });
        expect(typeof waiting?.payload.since).toBe("string");

        const delivered = registry.followUpByRunId("piw_test_run", {
          role: "user",
          content: "Resume with approved path.",
          timestamp: Date.now(),
        });
        expect(delivered).toBe(true);
        expect(agent.followUp).toHaveBeenCalledTimes(1);
        expect(supervisor.checkpointPhase).toBe("running");
        expect(await agent.finishToolCall(toolResult)).toBeUndefined();
        supervisor.stop();
        return {
          status: "completed",
          artifacts: [{ type: "test", ref: "checkpoint", summary: "ok" }],
          filesTouched: [],
          toolsUsed: ["request_checkpoint"],
          tokensConsumed: 0,
          summary: "checkpoint protocol",
        };
      },
    };

    await makeRuntime(bus, registry, checkpointPoster).executeAssignment(makeBinding(), executor);
    expect(checkpointPoster).toHaveBeenCalledTimes(1);
  });
});
