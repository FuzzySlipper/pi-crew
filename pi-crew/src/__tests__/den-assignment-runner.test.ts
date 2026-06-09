import { describe, expect, it } from "vitest";
import type { CompletionPacket } from "@pi-crew/core";
import type { MCPClient, ToolCallResult } from "@pi-crew/mcp";
import type { WorkerBinding, WorkerExecutor } from "@pi-crew/service";
import { Crew, CrewConfigSchema, type CrewConfig } from "../crew.js";
import {
  DenAssignmentRunnerError,
  createDenAssignmentRunner,
  type DenAssignmentRunnerRuntime,
} from "../den-assignment-runner.js";
import type { DenPoolAssignmentConsumer } from "../den-pool-source.js";

class FakeMcpClient {
  readonly calls: Array<{ readonly name: string; readonly params: Record<string, unknown> }> = [];

  constructor(private readonly responses: ToolCallResult[] = []) {}

  callTool(name: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    this.calls.push({ name, params });
    return Promise.resolve(this.responses.shift() ?? ok({ summary: "ok" }));
  }
}

class TerminalAwareMcpClient {
  readonly calls: Array<{ readonly name: string; readonly params: Record<string, unknown> }> = [];
  #terminal = false;

  callTool(name: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    this.calls.push({ name, params });
    if (name === "post_worker_completion_packet") {
      this.#terminal = true;
      return Promise.resolve(ok({ summary: "failed packet posted" }));
    }
    if (name === "record_cleanup_evidence" && !this.#terminal) {
      return Promise.resolve(fail("assignment is not terminal"));
    }
    return Promise.resolve(ok({ summary: "ok" }));
  }
}

class FakeConsumer implements DenPoolAssignmentConsumer {
  constructor(
    private readonly result: Awaited<
      ReturnType<DenPoolAssignmentConsumer["consumeNextAssignment"]>
    >,
  ) {}

  consumeNextAssignment(): Promise<
    Awaited<ReturnType<DenPoolAssignmentConsumer["consumeNextAssignment"]>>
  > {
    return Promise.resolve(this.result);
  }
}

class FakeRuntime implements DenAssignmentRunnerRuntime {
  readonly calls: Array<{ readonly binding: WorkerBinding; readonly executor: WorkerExecutor }> =
    [];

  constructor(private readonly result: CompletionPacket | Error) {}

  executeAssignment(binding: WorkerBinding, executor: WorkerExecutor): Promise<CompletionPacket> {
    this.calls.push({ binding, executor });
    if (this.result instanceof Error) return Promise.reject(this.result);
    return Promise.resolve(this.result);
  }
}

const noopExecutor: WorkerExecutor = {
  execute: () =>
    Promise.resolve({
      status: "completed",
      artifacts: [{ type: "noop", ref: "noop", summary: "noop" }],
      filesTouched: [],
      toolsUsed: [],
      tokensConsumed: 0,
      summary: "noop",
    }),
};

function ok(value: unknown): ToolCallResult {
  return {
    ok: true,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function fail(error: string): ToolCallResult {
  return { ok: false, error, content: [] };
}

function binding(): WorkerBinding {
  return {
    assignmentId: "1142",
    runId: "piw_2182_assignment",
    taskId: "2182",
    projectId: "pi-crew",
    role: "coder",
  };
}

function packet(status: CompletionPacket["status"] = "completed"): CompletionPacket {
  return {
    assignmentId: "1142",
    runId: "piw_2182_assignment",
    taskId: "2182",
    role: "coder",
    status,
    artifacts: [{ type: "implementation", ref: "commit:abc", summary: "done" }],
    filesTouched: ["pi-crew/src/example.ts"],
    toolsUsed: ["post_structured_completion"],
    tokensConsumed: 42,
    durationMs: 100,
    turnCount: 1,
    completedAt: "2026-06-09T11:00:00.000Z",
  };
}

function assignmentConsumer(): DenPoolAssignmentConsumer {
  return new FakeConsumer({
    status: "assignment",
    binding: binding(),
    readback: {
      workerIdentity: "pi-crew-coder-1",
      profileIdentity: "coder-worker",
      role: "coder",
      assignmentId: "1142",
      runId: "piw_2182_assignment",
      taskId: "2182",
      projectId: "pi-crew",
    },
  });
}

function makeTestCrewConfig(): CrewConfig {
  const parsed = CrewConfigSchema.safeParse({
    database: { path: ":memory:", wal: false },
    health: { host: "127.0.0.1", port: 21_820 },
    den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
    workerPool: {
      members: [
        {
          workerIdentity: "pi-crew-coder-1",
          profileIdentity: "coder-worker",
          role: "coder",
          displayName: "Pi Crew Coder 1",
          capabilities: ["typescript", "den"],
        },
      ],
    },
  });
  if (!parsed.success) throw new Error("test config should parse");
  return parsed.data;
}

describe("DenAssignmentRunner", () => {
  it("executes one Den assignment through WorkerRuntime and releases with cleanup evidence", async () => {
    const client = new FakeMcpClient();
    const runtime = new FakeRuntime(packet());
    const runner = createDenAssignmentRunner({
      assignmentConsumer: assignmentConsumer(),
      workerRuntime: runtime,
      executorFactory: () => noopExecutor,
      mcpClient: client as unknown as MCPClient,
      workerIdentity: "pi-crew-coder-1",
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("completed");
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.binding).toEqual(binding());
    expect(runtime.calls[0]?.executor).toBe(noopExecutor);
    expect(client.calls).toEqual([
      {
        name: "record_cleanup_evidence",
        params: {
          assignment_id: 1142,
          evidence: JSON.stringify({
            workerIdentity: "pi-crew-coder-1",
            runId: "piw_2182_assignment",
            taskId: "2182",
            status: "completed",
            completionPosted: true,
          }),
        },
      },
      {
        name: "release_assignment",
        params: { assignment_id: 1142 },
      },
    ]);
  });

  it("does not execute or release when Den has no assignment", async () => {
    const client = new FakeMcpClient();
    const runtime = new FakeRuntime(packet());
    const runner = createDenAssignmentRunner({
      assignmentConsumer: new FakeConsumer({
        status: "no_assignment",
        reason: "none_available",
        diagnostic: "No ack assignment envelope is available.",
      }),
      workerRuntime: runtime,
      executorFactory: () => noopExecutor,
      mcpClient: client as unknown as MCPClient,
      workerIdentity: "pi-crew-coder-1",
    });

    await expect(runner.runOnce()).resolves.toEqual({
      status: "no_assignment",
      reason: "none_available",
      diagnostic: "No ack assignment envelope is available.",
    });
    expect(runtime.calls).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it("posts failed completion before cleanup evidence when WorkerRuntime throws", async () => {
    const client = new TerminalAwareMcpClient();
    const runtime = new FakeRuntime(new Error("model config unavailable"));
    const runner = createDenAssignmentRunner({
      assignmentConsumer: assignmentConsumer(),
      workerRuntime: runtime,
      executorFactory: () => noopExecutor,
      mcpClient: client as unknown as MCPClient,
      workerIdentity: "pi-crew-coder-1",
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed runner result");
    expect(result.error).toBe("model config unavailable");
    expect(client.calls[0]?.name).toBe("post_worker_completion_packet");
    expect(client.calls[0]?.params).toMatchObject({
      project_id: "pi-crew",
      run_id: "piw_2182_assignment",
      requested_by: "pi-crew-coder-1",
      status: "failed",
      role: "coder",
      packet_type: "implementation_packet",
    });
    expect(client.calls[1]).toEqual({
      name: "record_cleanup_evidence",
      params: {
        assignment_id: 1142,
        evidence: JSON.stringify({
          workerIdentity: "pi-crew-coder-1",
          runId: "piw_2182_assignment",
          taskId: "2182",
          status: "failed",
          completionPosted: false,
          error: "model config unavailable",
        }),
      },
    });
    expect(client.calls[2]).toEqual({
      name: "release_assignment",
      params: { assignment_id: 1142 },
    });
  });

  it("fails closed when Den cleanup evidence or release calls fail", async () => {
    const client = new FakeMcpClient([fail("cleanup MCP unavailable")]);
    const runner = createDenAssignmentRunner({
      assignmentConsumer: assignmentConsumer(),
      workerRuntime: new FakeRuntime(packet()),
      executorFactory: () => noopExecutor,
      mcpClient: client as unknown as MCPClient,
      workerIdentity: "pi-crew-coder-1",
    });

    await expect(runner.runOnce()).rejects.toThrow(DenAssignmentRunnerError);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.name).toBe("record_cleanup_evidence");
  });

  it("provides production Crew wiring that uses the configured Den pool member lane", () => {
    const crew = new Crew(makeTestCrewConfig());

    const runner = crew.createDenAssignmentRunner(crew.config.workerPool.members[0]);

    expect(runner).toBeDefined();
    expect(crew.config.workerPool.members[0]?.workerIdentity).toBe("pi-crew-coder-1");
    void crew.stop("den-assignment-runner-test-cleanup");
  });
});
