/** Tests for production LLM-backed Agent worker executor. */

import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { AgentWorkerExecutor } from "../../workers/agent-worker-executor.js";
import type {
  AgentWorkerAdapter,
  AgentWorkerFactory,
  AgentWorkerFactoryInput,
  WorkerModelConfigSource,
} from "../../workers/agent-worker-executor.js";
import { WorkerRuntime } from "../../workers/worker-runtime.js";
import type { AgentTool } from "../../workers/guarded-tool-types.js";
import {
  FakeAuditRepo,
  FakeSessionManager,
  makeAcceptingPoster,
  makeBinding,
  makeFakePool,
  makeRoleMapping,
} from "./worker-runtime-test-fixtures.js";

class FakeWorkerAgent implements AgentWorkerAdapter {
  readonly prompts: AgentMessage[][] = [];
  readonly #listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
  readonly #signal = new AbortController().signal;
  aborted = false;
  state = { tools: [] as AgentTool[] };
  beforeToolCall: unknown;
  afterToolCall: unknown;

  constructor(private readonly callCompletionTool = true) {}

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.#listeners.push(listener);
    return () => undefined;
  }

  async prompt(messages: AgentMessage[]): Promise<void> {
    this.prompts.push(messages);
    await this.feed({ type: "agent_start" }, { type: "turn_start" }, messageEnd(37), turnEnd(), {
      type: "agent_end",
      messages,
    });
    if (this.callCompletionTool) {
      const completionTool = this.state.tools.find((tool) => tool.name === "post_structured_completion");
      await completionTool?.execute("completion-call", {}, this.#signal);
    }
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  abort(): void {
    this.aborted = true;
  }

  steer(message: AgentMessage): void {
    void message;
  }

  followUp(message: AgentMessage): void {
    void message;
  }

  hasQueuedMessages(): boolean {
    return false;
  }

  private async feed(...events: AgentEvent[]): Promise<void> {
    for (const event of events) {
      for (const listener of this.#listeners) {
        await listener(event, this.#signal);
      }
    }
  }
}

class CapturingAgentFactory implements AgentWorkerFactory {
  readonly agent: FakeWorkerAgent;
  readonly created: Array<{
    readonly provider: string;
    readonly model: string;
    readonly baseUrl: string;
    readonly systemPrompt: string;
    readonly sessionId: string;
  }> = [];

  constructor(callCompletionTool = true) {
    this.agent = new FakeWorkerAgent(callCompletionTool);
  }

  create(input: AgentWorkerFactoryInput): AgentWorkerAdapter {
    this.created.push({
      provider: input.model.provider,
      model: input.model.id,
      baseUrl: input.model.baseUrl,
      systemPrompt: input.systemPrompt,
      sessionId: input.sessionId,
    });
    return this.agent;
  }
}

function messageEnd(tokens: number): AgentEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "local-openai-compatible",
      model: "local-model",
      usage: {
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
}

function turnEnd(): AgentEvent {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "local-openai-compatible",
      model: "local-model",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    },
    toolResults: [],
  } as unknown as AgentEvent;
}

function makeModelSource(): WorkerModelConfigSource {
  return {
    getProfileModelConfig(profileId: string) {
      expect(profileId).toBe("spawned-coder");
      return {
        provider: "profile-provider",
        modelName: "profile-model",
        temperature: 0.4,
        maxTokens: 128,
      };
    },
  };
}

function makeCompletionTool(): AgentTool {
  return {
    label: "Post completion",
    name: "post_structured_completion",
    description: "Post structured completion packet",
    parameters: { type: "object" },
    execute: () =>
      Promise.resolve({
        content: [{ type: "text", text: "posted" }],
        details: { ok: true },
      }),
  };
}

function makeTaskTool(): AgentTool {
  return {
    label: "Get task",
    name: "mcp_den_get_task",
    description: "Fetch Den task details",
    parameters: { type: "object" },
    execute: () =>
      Promise.resolve({
        content: [{ type: "text", text: "task" }],
        details: { ok: true },
      }),
  };
}

describe("AgentWorkerExecutor", () => {
  it("constructs and runs a real Agent-backed worker from role assembly and model config", async () => {
    const factory = new CapturingAgentFactory();
    const bus = new FakeEventBus();
    const mapping = {
      bindings: makeRoleMapping().bindings.map((binding) =>
        binding.role === "coder"
          ? {
              ...binding,
              config: {
                ...binding.config,
                executionMode: "llmAgent" as const,
                modelProvider: "local-openai-compatible",
                modelName: "local-model",
                modelBaseUrl: "http://192.168.1.23:13305/v1",
              },
            }
          : binding,
      ),
    };
    const runtime = new WorkerRuntime(
      { workerIdentity: "llm-worker" },
      mapping,
      new FakeSessionManager(),
      makeFakePool(),
      bus,
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    const packet = await runtime.executeAssignment(
      makeBinding({ role: "coder", taskId: "2155" }),
      new AgentWorkerExecutor({
        agentFactory: factory,
        modelConfigSource: makeModelSource(),
        toolProvider: () => [makeCompletionTool(), makeTaskTool()],
      }),
    );

    expect(factory.created).toEqual([
      expect.objectContaining({
        provider: "local-openai-compatible",
        model: "local-model",
        baseUrl: "http://192.168.1.23:13305/v1",
        sessionId: "session-1",
      }),
    ]);
    expect(factory.created[0]?.systemPrompt).toContain("You are a Coder worker");
    expect(factory.agent.prompts[0]?.[0]?.role).toBe("user");
    expect(factory.agent.state.tools.map((tool) => tool.name)).toContain(
      "post_structured_completion",
    );
    expect(packet.status).toBe("completed");
    expect(packet.taskId).toBe("2155");
    expect(packet.turnCount).toBe(1);
    expect(packet.tokensConsumed).toBe(37);
    expect(packet.artifacts[0]?.type).toBe("llm_agent_worker_run");
    expect(bus.emitted.some((event) => event.event === "turn.started")).toBe(true);
  });

  it("fails closed when LLM Agent mode lacks model/provider configuration", async () => {
    const mapping = {
      bindings: makeRoleMapping().bindings.map((binding) =>
        binding.role === "coder"
          ? { ...binding, config: { ...binding.config, executionMode: "llmAgent" as const } }
          : binding,
      ),
    };
    const runtime = new WorkerRuntime(
      { workerIdentity: "llm-worker" },
      mapping,
      new FakeSessionManager(),
      makeFakePool(),
      new FakeEventBus(),
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    const packet = await runtime.executeAssignment(
      makeBinding({ role: "coder" }),
      new AgentWorkerExecutor({
        agentFactory: new CapturingAgentFactory(),
        modelConfigSource: { getProfileModelConfig: () => undefined },
        toolProvider: () => [makeCompletionTool(), makeTaskTool()],
      }),
    );

    expect(packet.status).toBe("failed");
    expect(packet.blocker?.reason).toContain("requires modelProvider and modelName");
  });

  it("fails closed when the Agent stops without calling post_structured_completion", async () => {
    const mapping = {
      bindings: makeRoleMapping().bindings.map((binding) =>
        binding.role === "coder"
          ? {
              ...binding,
              config: {
                ...binding.config,
                executionMode: "llmAgent" as const,
                modelProvider: "local-openai-compatible",
                modelName: "local-model",
                modelBaseUrl: "http://192.168.1.23:13305/v1",
              },
            }
          : binding,
      ),
    };
    const runtime = new WorkerRuntime(
      { workerIdentity: "llm-worker" },
      mapping,
      new FakeSessionManager(),
      makeFakePool(),
      new FakeEventBus(),
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    const packet = await runtime.executeAssignment(
      makeBinding({ role: "coder" }),
      new AgentWorkerExecutor({
        agentFactory: new CapturingAgentFactory(false),
        modelConfigSource: { getProfileModelConfig: () => undefined },
        toolProvider: () => [makeCompletionTool(), makeTaskTool()],
      }),
    );

    expect(packet.status).toBe("failed");
    expect(packet.artifacts[0]?.type).toBe("llm_agent_missing_completion");
    expect(packet.blocker?.reason).toBe("post_structured_completion was not called");
  });

  it("fails closed when only the completion marker is available", async () => {
    const mapping = {
      bindings: makeRoleMapping().bindings.map((binding) =>
        binding.role === "coder"
          ? {
              ...binding,
              config: {
                ...binding.config,
                executionMode: "llmAgent" as const,
                modelProvider: "local-openai-compatible",
                modelName: "local-model",
                modelBaseUrl: "http://192.168.1.23:13305/v1",
              },
            }
          : binding,
      ),
    };
    const runtime = new WorkerRuntime(
      { workerIdentity: "llm-worker" },
      mapping,
      new FakeSessionManager(),
      makeFakePool(),
      new FakeEventBus(),
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    const packet = await runtime.executeAssignment(
      makeBinding({ role: "coder" }),
      new AgentWorkerExecutor({
        agentFactory: new CapturingAgentFactory(),
        modelConfigSource: { getProfileModelConfig: () => undefined },
        toolProvider: () => [makeCompletionTool()],
      }),
    );

    expect(packet.status).toBe("failed");
    expect(packet.blocker?.reason).toContain("requires at least one selected work tool");
  });
});
