import { describe, expect, it } from "vitest";

import {
  DEN_MEMORY_TOOL_NAMES,
  DenMemoryClient,
  PiCrewDenMemoryAdapter,
  createPiCrewRuntimeContext,
  defaultPolicyMode,
  defaultSourceRefs,
  registerDenMemoryTools,
  type DenMemoryPolicyMode,
  type DenMemoryToolDefinition,
} from "./index.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

function makeFetch(handler: (input: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    return handler(url, init);
  };
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function adapterWithFetch(fetchImpl: typeof fetch, policyMode?: DenMemoryPolicyMode): PiCrewDenMemoryAdapter {
  const client = new DenMemoryClient({ baseUrl: "http://den-memory.local", fetchImpl });
  return new PiCrewDenMemoryAdapter({
    client,
    runtimeContext: createPiCrewRuntimeContext({
      agentIdentity: "pi-worker",
      profileId: "pi-worker",
      sessionId: "session-1",
      projectId: "den-memory",
      taskId: 2476,
      assignmentId: "assign-1",
      runId: "run-1",
      role: "worker",
      mode: "implementation",
    }),
    policyMode,
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
    expect(defaultPolicyMode(context)).toBe("metadata_only");
  });

  it("exposes five shared logical tools without name collisions", () => {
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

  it("manual recall returns service packet semantics and normalizes hyphenated terms for service FTS", async () => {
    let sawRuntimeContext = false;
    let sawQuery = "";
    const adapter = adapterWithFetch(makeFetch((url, init) => {
      expect(url.pathname).toBe("/api/recall");
      const body = parseBody(init);
      sawQuery = String(body.query);
      sawRuntimeContext = body.runtime_context instanceof Object && (body.runtime_context as Record<string, unknown>).runtime === "pi_crew" && (body.runtime_context as Record<string, unknown>).assignment_id === "assign-1";
      return jsonResponse({ packet_id: "packet-1", packet_md: "# packet", root_matches: [], included_nodes: [{ slug: "same-semantics" }], skipped: [], warnings: [], provenance: [] });
    }));

    const result = await adapter.callTool("den_memory_recall", { query: "pi-crew same seed" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ packet_id: "packet-1" });
    expect(sawRuntimeContext).toBe(true);
    expect(sawQuery).toBe("pi crew same seed");
  });

  it("candidate store attaches worker assignment source refs without promotion", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = adapterWithFetch(makeFetch((url, init) => {
      expect(url.pathname).toBe("/api/candidates");
      body = parseBody(init);
      return jsonResponse({ candidate: { id: 42, curation_state: "candidate" } });
    }), "permissive_candidates");

    const result = await adapter.callTool("den_memory_propose", { title: "Candidate", body_md: "body", proposed_kind: "procedure_note" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ candidate: { curation_state: "candidate" } });
    expect(body).toBeDefined();
    const candidateBody = body ?? {};
    expect(candidateBody).toMatchObject({ created_by: "pi-worker", curation_state: "candidate" });
    const refs = candidateBody.source_refs as Array<Record<string, unknown>>;
    expect(refs[0]).toMatchObject({ source_kind: "pi_crew_assignment", source_project_id: "den-memory", source_id: "assign-1" });
    expect(refs[0]?.source_locator).toMatchObject({ task_id: 2476, assignment_id: "assign-1", run_id: "run-1" });
  });

  it("metadata-only worker policy denies candidate body storage", async () => {
    let called = false;
    const adapter = adapterWithFetch(makeFetch(() => {
      called = true;
      return jsonResponse({ ok: true });
    }), "metadata_only");

    const result = await adapter.callTool("den_memory_propose", { title: "Candidate", body_md: "body", proposed_kind: "procedure_note" });
    expect(result).toMatchObject({ ok: false, code: "policy_candidate_store_denied", toolName: "den_memory_propose" });
    expect(called).toBe(false);
  });

  it("default source refs fall back to task or session handles", () => {
    expect(defaultSourceRefs(createPiCrewRuntimeContext({ projectId: "pi-crew", taskId: 2449 }))[0]).toMatchObject({ source_kind: "den_task", source_id: "2449" });
    expect(defaultSourceRefs(createPiCrewRuntimeContext({ sessionId: "s1", sessionKind: "durable_agent" }))[0]).toMatchObject({ source_kind: "pi_crew_session", source_id: "s1" });
  });

  it("service unavailable returns typed tool error", async () => {
    const adapter = adapterWithFetch(makeFetch(() => {
      throw new Error("service unavailable");
    }));
    const result = await adapter.callTool("den_memory_read", { slug: "missing" });
    expect(result.ok).toBe(false);
    expect(result.toolName).toBe("den_memory_read");
    expect(result.code).toBe("request_failed");
    expect(result.error).toContain("service unavailable");
  });

  it("prompt heading describes store vs propose semantics", () => {
    const adapter = adapterWithFetch(makeFetch(() => jsonResponse({ ok: true })));
    const heading = adapter.promptHeading();
    expect(heading).toContain("den_memory_store auto-promotes");
    expect(heading).toContain("den_memory_propose is candidate-only");
    expect(heading).not.toContain("included_nodes");
    expect(heading).not.toContain("packet_md");
  });
});
