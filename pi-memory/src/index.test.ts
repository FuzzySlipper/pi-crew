import { describe, expect, it } from "vitest";

import {
  DEN_MEMORY_TOOL_NAMES,
  DenMemoryClient,
  PiCrewDenMemoryAdapter,
  createPiCrewRuntimeContext,
  defaultCaptureMode,
  registerDenMemoryTools,
  type DenMemoryToolDefinition,
} from "./index.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

function makeFetch(handler: (input: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    return handler(url, init);
  }) as typeof fetch;
}

function adapterWithFetch(fetchImpl: typeof fetch): PiCrewDenMemoryAdapter {
  const client = new DenMemoryClient({ baseUrl: "http://den-memory.local", fetchImpl });
  return PiCrewDenMemoryAdapter.fromContext(client, {
    agentIdentity: "pi-worker",
    profileId: "pi-worker",
    sessionId: "session-1",
    projectId: "den-memory",
    taskId: 2476,
    assignmentId: "assign-1",
    runId: "run-1",
    role: "worker",
    mode: "implementation",
  });
}

describe("pi-memory Den Memories adapter", () => {
  it("maps pi-crew worker assignment context into shared runtime_context", () => {
    const context = createPiCrewRuntimeContext({
      agentIdentity: "pi-runner",
      profileId: "pi-runner",
      sessionId: "s1",
      projectId: "den-memory",
      taskId: 2476,
      assignmentId: "a1",
      runId: "r1",
      role: "worker",
    });

    expect(context).toMatchObject({
      runtime: "pi_crew",
      agent_identity: "pi-runner",
      profile_id: "pi-runner",
      session_id: "s1",
      session_kind: "worker_assignment",
      project_id: "den-memory",
      task_id: 2476,
      assignment_id: "a1",
      run_id: "r1",
      role: "worker",
      mode: "implementation",
    });
    expect(defaultCaptureMode(context)).toBe("metadata_only");
  });

  it("exposes shared logical tools without name collisions", () => {
    const adapter = adapterWithFetch(makeFetch(() => jsonResponse({ ok: true })));
    const tools = adapter.toolDefinitions();
    const names = tools.map((tool) => tool.name);
    expect(names.sort()).toEqual([...DEN_MEMORY_TOOL_NAMES].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);

    const registered: DenMemoryToolDefinition[] = [];
    registerDenMemoryTools({ registerStatic: (tool) => registered.push(tool) }, adapter);
    expect(registered.map((tool) => tool.name).sort()).toEqual([...DEN_MEMORY_TOOL_NAMES].sort());
  });

  it("manual recall returns service packet semantics", async () => {
    let sawRuntimeContext = false;
    const adapter = adapterWithFetch(makeFetch(async (url, init) => {
      expect(url.pathname).toBe("/api/recall");
      const body = JSON.parse(String(init?.body));
      sawRuntimeContext = body.runtime_context.runtime === "pi_crew" && body.runtime_context.assignment_id === "assign-1";
      return jsonResponse({ packet_id: "packet-1", included_nodes: [{ slug: "same-semantics" }], warnings: [] });
    }));

    const result = await adapter.callTool("den_memory_recall", { query: "same seed" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ packet_id: "packet-1" });
    expect(sawRuntimeContext).toBe(true);
  });

  it("capture attaches worker assignment source refs and creates candidates only when enabled", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = adapterWithFetch(makeFetch(async (url, init) => {
      expect(url.pathname).toBe("/api/capture");
      body = JSON.parse(String(init?.body));
      return jsonResponse({ decision: "captured", candidate_ids: [42], candidate: { id: 42, status: "pending" }, capture_event_id: 7 });
    }));
    const permissive = new PiCrewDenMemoryAdapter({ client: adapter.client, runtimeContext: adapter.runtimeContext, captureMode: "permissive_candidates" });

    const result = await permissive.callTool("den_memory_capture_event", { raw_text: "task handoff candidate" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ decision: "captured", candidate: { status: "pending" } });
    expect(body).toBeDefined();
    expect(body).toMatchObject({ runtime: "pi_crew", actor_identity: "pi-worker", capture_mode: "permissive_candidates" });
    const refs = body!.source_refs as Array<Record<string, unknown>>;
    expect(refs[0]).toBeDefined();
    expect(refs[0]!).toMatchObject({ source_kind: "pi_crew_assignment", source_project_id: "den-memory", source_id: "assign-1" });
    expect(refs[0]!["source_locator"]).toMatchObject({ task_id: 2476, assignment_id: "assign-1", run_id: "run-1" });
  });

  it("worker default capture mode remains metadata_only", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = adapterWithFetch(makeFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ decision: "ignored", reason: "metadata_only", candidate_ids: [], capture_event_id: 1 });
    }));

    const result = await adapter.callTool("den_memory_capture_event", { raw_text: "worker data" });
    expect(result.ok).toBe(true);
    expect(body?.capture_mode).toBe("metadata_only");
    expect(result.data).toMatchObject({ decision: "ignored", reason: "metadata_only" });
  });

  it("service unavailable returns typed tool error", async () => {
    const adapter = adapterWithFetch(makeFetch(() => {
      throw new Error("service unavailable");
    }));
    const result = await adapter.callTool("den_memory_doctor");
    expect(result.ok).toBe(false);
    expect(result.toolName).toBe("den_memory_doctor");
    expect(result.error).toContain("service unavailable");
  });

  it("prompt heading is policy-only and contains no memory body", () => {
    const adapter = adapterWithFetch(makeFetch(() => jsonResponse({ ok: true })));
    const heading = adapter.promptHeading();
    expect(heading).toContain("explicit tools only");
    expect(heading).not.toContain("included_nodes");
    expect(heading).not.toContain("packet_md");
  });
});
