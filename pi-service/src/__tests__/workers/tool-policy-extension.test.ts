import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger, InMemoryHookRegistry } from "@pi-crew/core";
import { loadConfig } from "../../config.js";
import { createServiceExtensionContext, createUnavailableDelegationSessionBridge } from "../../extension-activator.js";
import { buildGuardedToolContext } from "../../workers/guarded-tool-context-factory.js";
import { installGuardedAgentRuntime } from "../../workers/guarded-agent-installer.js";
import { WorkerRuntime, type WorkerExecutor } from "../../workers/worker-runtime.js";
import {
  InMemoryToolPolicySessionRegistry,
  ToolPolicyExtension,
} from "../../workers/tool-policy-extension.js";
import type { SessionRecord, WorkerBinding } from "../../sessions/types.js";
import type { AgentTool, AgentToolResult } from "../../workers/guarded-tool-types.js";
import type { WorkerRoleConfig, WorkerRoleMappingConfig } from "../../workers/worker-role-config.js";
import {
  FakeAuditRepo,
  FakeSessionManager,
  makeFakePool,
} from "./worker-runtime-test-fixtures.js";

class FakeAgent {
  beforeToolCall?: Parameters<typeof installGuardedAgentRuntime>[0]["beforeToolCall"];
  afterToolCall?: Parameters<typeof installGuardedAgentRuntime>[0]["afterToolCall"];
  readonly executed: string[] = [];
  readonly state = {
    tools: [this.createTool("dangerous_tool"), this.createTool("safe_tool")],
  };

  subscribe(): () => void {
    return () => {};
  }

  async callThroughAgent(toolName: string): Promise<AgentToolResult> {
    const tool = this.state.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      return { content: [{ type: "text", text: "missing tool" }], details: {} };
    }
    const before = await this.beforeToolCall?.({
      toolCall: { type: "toolCall", id: `call-${toolName}`, name: toolName, input: {} },
      args: {},
    });
    if (before?.block) {
      return {
        content: [{ type: "text", text: before.reason ?? "blocked" }],
        details: { blocked: true },
      };
    }
    return tool.execute(`call-${toolName}`, {});
  }

  private createTool(name: string): AgentTool {
    return {
      name,
      label: name,
      description: `${name} description`,
      parameters: { type: "object", properties: {} },
      execute: (): Promise<AgentToolResult> => {
        this.executed.push(name);
        return Promise.resolve({
          content: [{ type: "text", text: `${name} executed` }],
          details: { executed: true },
        });
      },
    };
  }
}

function makeBinding(): WorkerBinding {
  return {
    assignmentId: "711",
    runId: "piw_hook_policy",
    taskId: "2165",
    projectId: "pi-crew",
    role: "coder",
  };
}

function makeSession(): SessionRecord {
  return {
    id: "session-hook-policy",
    profileId: "spawned-coder",
    instanceId: "instance-hook-policy",
    kind: "worker",
    state: "active",
    createdAt: "2026-06-09T00:00:00.000Z",
    lastActiveAt: "2026-06-09T00:00:00.000Z",
    messageCount: 0,
    channelBindings: [],
    workerBinding: makeBinding(),
  };
}

function makeRoleConfig(): WorkerRoleConfig {
  return {
    toolPolicyDefaults: {
      deniedTools: ["dangerous_tool"],
      workdirRoot: "/tmp/pi-worker",
    },
    drainEssentialTools: ["context_status", "post_structured_completion", "request_checkpoint"],
  };
}

function makeRoleMapping(): WorkerRoleMappingConfig {
  return {
    bindings: [{ role: "coder", profileId: "spawned-coder", config: makeRoleConfig() }],
  };
}

function makeExtensionHarness(): {
  readonly eventBus: FakeEventBus;
  readonly hookRegistry: InMemoryHookRegistry;
  readonly registry: InMemoryToolPolicySessionRegistry;
  readonly extension: ToolPolicyExtension;
} {
  const eventBus = new FakeEventBus();
  const logger = new FakeLogger();
  const hookRegistry = new InMemoryHookRegistry(logger);
  const registry = new InMemoryToolPolicySessionRegistry();
  const extension = new ToolPolicyExtension(registry);
  const context = createServiceExtensionContext({
    config: loadConfig({ den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false } }),
    logger,
    eventBus,
    hookRegistry,
    delegationSessions: createUnavailableDelegationSessionBridge(),
  });
  void extension.activate(context);
  return { eventBus, hookRegistry, registry, extension };
}

function makeGuardedContext(harness: ReturnType<typeof makeExtensionHarness>) {
  return buildGuardedToolContext(
    makeBinding(),
    makeSession(),
    "spawned-coder",
    makeRoleConfig(),
    harness.eventBus,
    new FakeLogger(),
    { hookRegistry: harness.hookRegistry, toolPolicySessionRegistry: harness.registry },
  );
}

describe("ToolPolicyExtension hook migration", () => {
  it("blocks pre-execution tool denial through HookRegistry before the underlying tool executes", async () => {
    const harness = makeExtensionHarness();
    const guardedContext = makeGuardedContext(harness);
    const agent = new FakeAgent();

    installGuardedAgentRuntime(agent, guardedContext, null);
    const result = await agent.callThroughAgent("dangerous_tool");

    expect(agent.executed).toEqual([]);
    expect(result.content[0]?.type).toBe("text");
    expect(textContent(result.content[0])).toContain("dangerous_tool");
    expect(textContent(result.content[0])).toContain("denied");
    expect(harness.eventBus.emitted.some((event) => event.event === "tool.denied")).toBe(true);
    guardedContext.dispose?.();
    await harness.extension.deactivate();
  });

  it("keeps dispatch-time wrapper policy checks as a second line of defense", async () => {
    const harness = makeExtensionHarness();
    const guardedContext = makeGuardedContext(harness);
    const agent = new FakeAgent();

    installGuardedAgentRuntime(agent, guardedContext, null);
    const dangerousTool = agent.state.tools.find((tool) => tool.name === "dangerous_tool");
    const result = await dangerousTool?.execute("direct-wrapper", {});

    expect(agent.executed).toEqual([]);
    expect(textContent(result?.content[0])).toContain("dangerous_tool");
    expect(textContent(result?.content[0])).toContain("denied");
    guardedContext.dispose?.();
    await harness.extension.deactivate();
  });

  it("applies after_tool_call redaction modifiers through HookRegistry", async () => {
    const harness = makeExtensionHarness();
    const guardedContext = makeGuardedContext(harness);
    const hooks = guardedContext.createGuardedToolHooks();

    const result = await hooks.afterToolCall({
      toolCall: { type: "toolCall", id: "call-safe", name: "safe_tool", input: {} },
      args: {},
      result: {
        content: [{ type: "text", text: "secret api_key: sk-abc...wxyz" }],
        details: undefined,
      },
      isError: false,
    });

    expect(textContent(result?.content?.[0])).toContain("[REDACTED]");
    expect(textContent(result?.content?.[0])).not.toContain("sk-abc...wxyz");
    guardedContext.dispose?.();
    await harness.extension.deactivate();
  });

  it("preserves non-content after_tool_call modifier fields", async () => {
    const harness = makeExtensionHarness();
    const guardedContext = makeGuardedContext(harness);
    harness.hookRegistry.register("after_tool_call", () => ({
      isErrorOverride: true,
      terminate: true,
    }), { name: "test.after-tool-modifier", priority: 20 });
    const result = await guardedContext.createGuardedToolHooks().afterToolCall({
      toolCall: { type: "toolCall", id: "call-safe", name: "safe_tool", input: {} },
      args: {},
      result: { content: [{ type: "text", text: "ok" }], details: undefined },
      isError: false,
    });

    expect(result?.isError).toBe(true);
    expect(result?.terminate).toBe(true);
    guardedContext.dispose?.();
    await harness.extension.deactivate();
  });

  it("wires HookRegistry policy through the WorkerRuntime Agent supervisor path", async () => {
    const harness = makeExtensionHarness();
    const runtime = new WorkerRuntime(
      {
        workerIdentity: "hook-policy-worker",
        hookRegistry: harness.hookRegistry,
        toolPolicySessionRegistry: harness.registry,
      },
      makeRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      harness.eventBus,
      new FakeLogger(),
      new FakeAuditRepo(),
    );
    const executor: WorkerExecutor = {
      async execute(context) {
        const agent = new FakeAgent();
        context.createAgentSupervisor(agent);
        const result = await agent.callThroughAgent("dangerous_tool");
        expect(agent.executed).toEqual([]);
        expect(textContent(result.content[0])).toContain("denied");
        return {
          status: "completed",
          artifacts: [],
          filesTouched: [],
          toolsUsed: [],
          tokensConsumed: 0,
          summary: "hook policy exercised",
        };
      },
    };

    await runtime.executeAssignment(makeBinding(), executor);

    expect(harness.eventBus.emitted.some((event) => event.event === "tool.denied")).toBe(true);
    expect(harness.registry.get("session-1")).toBeUndefined();
    await harness.extension.deactivate();
  });
});

function textContent(content: AgentToolResult["content"][number] | undefined): string {
  if (content?.type !== "text") return "";
  return content.text;
}
