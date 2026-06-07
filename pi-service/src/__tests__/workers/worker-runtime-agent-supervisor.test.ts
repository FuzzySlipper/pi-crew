/** Tests for WorkerRuntime AgentSupervisor wiring. */

import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { WorkerRuntime, type WorkerExecutor } from "../../workers/worker-runtime.js";
import type { AgentLike } from "../../workers/agent-supervisor.js";
import type {
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from "../../workers/guarded-tool-types.js";
import type { WorkerRoleMappingConfig } from "../../workers/worker-role-config.js";
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

class FakeGuardedAgent extends FakeAgent {
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  readonly rawToolCalls: Array<{
    readonly toolCallId: string;
    readonly params: unknown;
  }> = [];
  override readonly state = {
    tools: [this.makeDangerousTool()],
  };

  async runToolCallThroughAgentPath(toolName: string): Promise<AgentToolResult> {
    const tool = this.state.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      return { content: [{ type: "text", text: "missing tool" }], details: {} };
    }

    const hookContext: BeforeToolCallContext = {
      toolCall: { type: "function", id: "call-guarded", name: toolName, input: {} },
      args: {},
    };
    const beforeResult = await this.beforeToolCall?.(hookContext);
    if (beforeResult?.block) {
      return {
        content: [{ type: "text", text: beforeResult.reason ?? "Tool execution was blocked" }],
        details: { blocked: true },
      };
    }

    return tool.execute("call-guarded", {});
  }

  private makeDangerousTool(): AgentTool {
    return {
      label: "Dangerous tool",
      name: "dangerous_tool",
      description: "A fake side-effecting tool",
      parameters: {},
      execute: (toolCallId: string, params: unknown): Promise<AgentToolResult> => {
        this.rawToolCalls.push({ toolCallId, params });
        return Promise.resolve({
          content: [{ type: "text", text: "dangerous executed" }],
          details: { executed: true },
        });
      },
    };
  }
}

function makeDeniedToolRoleMapping(): WorkerRoleMappingConfig {
  const base = makeRoleMapping();
  return {
    bindings: base.bindings.map((binding) =>
      binding.role === "coder"
        ? {
            ...binding,
            config: {
              ...binding.config,
              toolPolicyDefaults: {
                ...binding.config?.toolPolicyDefaults,
                deniedTools: ["dangerous_tool"],
              },
            },
          }
        : binding,
    ),
  };
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
  it("exposes PacketAuditorRoleAssembly on the runtime execution path", async () => {
    const auditRepo = new FakeAuditRepo();
    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      makeRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      new FakeEventBus(),
      new FakeLogger(),
      auditRepo,
      makeAcceptingPoster(),
    );

    await runtime.executeAssignment(makeBinding({ role: "packet-auditor" }), {
      execute: (context) => {
        const assembly = context.getWorkerRoleAssembly();
        expect(assembly?.role).toBe("packet-auditor");
        const input = context.buildWorkerRoleInput({
          projectId: "pi-crew",
          taskId: "1852",
          runId: "piw_20260605055314_f4b9fc66",
        });
        expect(input.sessionId).toBe("session-1");
        expect(input.profileId).toBe("packet-auditor");
        expect(input.targetPacketRef?.runId).toBe("piw_20260605055314_f4b9fc66");
        expect(assembly?.selectMcpToolSets(input)).toEqual(["den"]);
        return Promise.resolve({
          status: "completed",
          artifacts: [{ type: "audit_report", ref: "r", summary: "ok" }],
          filesTouched: [],
          toolsUsed: ["packet-auditor-role-assembly"],
          tokensConsumed: 0,
          summary: "role assembly reachable",
        });
      },
    });
  });

  it("installs guarded hooks and tool wrappers on the supervised Agent path", async () => {
    const bus = new FakeEventBus();
    const agent = new FakeGuardedAgent();
    const executor: WorkerExecutor = {
      async execute(context) {
        const supervisor = context.createAgentSupervisor(agent);
        expect(agent.beforeToolCall).toBeDefined();
        expect(agent.afterToolCall).toBeDefined();

        const result = await agent.runToolCallThroughAgentPath("dangerous_tool");
        const text = result.content.find((block) => block.type === "text")?.text;
        expect(text).toContain("denied");
        expect(agent.rawToolCalls).toHaveLength(0);

        const wrappedTool = agent.state.tools[0];
        if (wrappedTool === undefined) {
          throw new Error("expected guarded tool");
        }
        const wrapperResult = await wrappedTool.execute("call-wrapper", {});
        const wrapperText = wrapperResult.content.find((block) => block.type === "text")?.text;
        expect(wrapperText).toContain("dangerous_tool");
        expect(agent.rawToolCalls).toHaveLength(0);

        supervisor.stop();
        return {
          status: "completed",
          artifacts: [],
          filesTouched: [],
          toolsUsed: agent.state.tools.map((tool) => tool.name),
          tokensConsumed: 0,
          summary: "guarded-agent",
          turnCount: supervisor.turnCount,
        };
      },
    };

    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker" },
      makeDeniedToolRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      bus,
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    await runtime.executeAssignment(makeBinding(), executor);
    const deniedEvents = bus.emitted.filter((event) => event.event === "tool.denied");
    expect(deniedEvents).toHaveLength(2);
    expect(deniedEvents[0]?.payload.assignmentId).toBe("101");
  });

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
