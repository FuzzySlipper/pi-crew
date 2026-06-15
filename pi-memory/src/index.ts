// pi-memory — Den Memories adapter for pi-crew.
//
// This package is intentionally a thin runtime adapter. Den Memories owns the
// ontology, scoring, capture/curation, recall packets, and audit surfaces.
// pi-crew only maps worker/session context into shared service requests and
// exposes shared logical tools.

export type DenMemoryRuntime = "hermes" | "pi_crew" | "den_core" | "manual" | "import";
export type DenMemorySessionKind = "durable_agent" | "worker_assignment" | "assistant_delegate" | "cron" | "diagnostic" | "import";
export type DenMemoryRole = "planner" | "runner" | "reviewer" | "worker" | "assistant" | "human" | "auditor";
export type DenMemoryCaptureMode = "off" | "metadata_only" | "permissive_candidates" | "curated_manual_only";

export interface DenMemoryRuntimeContext {
  runtime: DenMemoryRuntime;
  agent_identity?: string;
  profile_id?: string;
  agent_instance_id?: string;
  session_id?: string;
  session_key?: string;
  session_kind: DenMemorySessionKind;
  project_id?: string;
  task_id?: string | number;
  assignment_id?: string | number | null;
  run_id?: string | null;
  role?: DenMemoryRole | string;
  audience?: string[];
  mode?: "planning" | "implementation" | "review" | "ops" | "general" | "audit" | string;
  source_surface?: string;
  user_id?: string;
}

export interface PiCrewMemoryContextInput {
  agentIdentity?: string;
  profileId?: string;
  agentInstanceId?: string;
  sessionId?: string;
  sessionKey?: string;
  sessionKind?: DenMemorySessionKind;
  projectId?: string;
  taskId?: string | number;
  assignmentId?: string | number | null;
  runId?: string | null;
  role?: DenMemoryRole | string;
  audience?: string[];
  mode?: DenMemoryRuntimeContext["mode"];
  sourceSurface?: string;
  userId?: string;
}

export interface DenMemorySourceRef {
  source_kind: string;
  source_project_id?: string | null;
  source_id: string;
  source_locator?: Record<string, unknown>;
  source_summary?: string;
  observed_at?: string | null;
  verified_at?: string | null;
  verification_status?: "unverified" | "verified" | "broken" | "stale";
}

export interface DenMemoryToolDefinition {
  name: DenMemoryToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DenMemoryToolCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  toolName?: string;
}

export type DenMemoryToolName =
  | "den_memory_recall"
  | "den_memory_read"
  | "den_memory_search"
  | "den_memory_store_candidate"
  | "den_memory_capture_event"
  | "den_memory_doctor"
  | "den_memory_audit_export";

export const DEN_MEMORY_TOOL_NAMES: readonly DenMemoryToolName[] = [
  "den_memory_recall",
  "den_memory_read",
  "den_memory_search",
  "den_memory_store_candidate",
  "den_memory_capture_event",
  "den_memory_doctor",
  "den_memory_audit_export",
];

export interface DenMemoryClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class DenMemoryClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: DenMemoryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async requestJson(method: string, path: string, body?: unknown, query?: Record<string, unknown>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Den Memories HTTP ${response.status}: ${text}`);
      }
      return text.length === 0 ? {} : JSON.parse(text);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface DenMemoryAdapterOptions {
  client: DenMemoryClient;
  runtimeContext: DenMemoryRuntimeContext;
  captureMode?: DenMemoryCaptureMode;
}

export class PiCrewDenMemoryAdapter {
  readonly client: DenMemoryClient;
  readonly runtimeContext: DenMemoryRuntimeContext;
  readonly captureMode: DenMemoryCaptureMode;

  constructor(options: DenMemoryAdapterOptions) {
    this.client = options.client;
    this.runtimeContext = options.runtimeContext;
    this.captureMode = options.captureMode ?? defaultCaptureMode(options.runtimeContext);
  }

  static fromContext(client: DenMemoryClient, input: PiCrewMemoryContextInput): PiCrewDenMemoryAdapter {
    return new PiCrewDenMemoryAdapter({ client, runtimeContext: createPiCrewRuntimeContext(input) });
  }

  promptHeading(): string {
    return "Den Memories: use explicit tools only; worker memory capture defaults to metadata/task-handoff candidates, not durable truth.";
  }

  toolDefinitions(): DenMemoryToolDefinition[] {
    return [
      tool("den_memory_recall", "Read-only guided recall packet from Den Memories.", { query: { type: "string" }, topic_view_slug: { type: "string" }, limit: { type: "number" } }, ["query"]),
      tool("den_memory_read", "Read a memory entry by slug.", { slug: { type: "string" } }, ["slug"]),
      tool("den_memory_search", "Search memory entries and candidates.", { query: { type: "string" }, include_candidates: { type: "boolean" }, limit: { type: "number" } }, ["query"]),
      tool("den_memory_store_candidate", "Create a pending memory candidate only; does not promote memory.", candidateProperties(), ["title", "body_md", "proposed_kind"]),
      tool("den_memory_capture_event", "Send a pi-crew runtime capture attempt through Den Memories policy.", { raw_text: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, event_kind: { type: "string" }, source_refs: { type: "array", items: { type: "object" } } }, ["raw_text"]),
      tool("den_memory_doctor", "Read-only Den Memories doctor report.", {}, []),
      tool("den_memory_audit_export", "Read-only JSONL/Markdown audit export for memory-free inspection.", { format: { type: "string", enum: ["jsonl", "json", "markdown"] }, since: { type: "string" }, until: { type: "string" } }, []),
    ];
  }

  async callTool(name: DenMemoryToolName, args: Record<string, unknown> = {}): Promise<DenMemoryToolCallResult> {
    try {
      switch (name) {
        case "den_memory_recall":
          return ok(await this.client.requestJson("POST", "/api/recall", { ...args, runtime_context: this.runtimeContext, scope_kind: "project", scope_id: this.runtimeContext.project_id }));
        case "den_memory_read":
          return ok(await this.client.requestJson("GET", `/api/memory-entries/${encodeURIComponent(String(args.slug))}`));
        case "den_memory_search": {
          const entries = await this.client.requestJson("POST", "/api/memory-entries/search", { query: args.query, limit: args.limit ?? 10 });
          if (args.include_candidates === true) {
            const candidates = await this.client.requestJson("POST", "/api/candidates/search", { query: args.query, limit: args.limit ?? 10 });
            return ok({ entries, candidates });
          }
          return ok(entries);
        }
        case "den_memory_store_candidate":
          return ok(await this.client.requestJson("POST", "/api/candidates", candidatePayload(this.runtimeContext, args)));
        case "den_memory_capture_event":
          return ok(await this.client.requestJson("POST", "/api/capture", capturePayload(this.runtimeContext, this.captureMode, args)));
        case "den_memory_doctor":
          return ok(await this.client.requestJson("GET", "/api/doctor/report"));
        case "den_memory_audit_export":
          return ok(await this.client.requestJson("GET", "/api/audit/export", undefined, { format: args.format ?? "json" }));
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), toolName: name };
    }
  }
}

export function createPiCrewRuntimeContext(input: PiCrewMemoryContextInput): DenMemoryRuntimeContext {
  const sessionKind = input.sessionKind ?? "worker_assignment";
  const role = input.role ?? (sessionKind === "worker_assignment" ? "worker" : "assistant");
  return {
    runtime: "pi_crew",
    agent_identity: input.agentIdentity,
    profile_id: input.profileId ?? input.agentIdentity,
    agent_instance_id: input.agentInstanceId,
    session_id: input.sessionId,
    session_key: input.sessionKey ?? input.sessionId,
    session_kind: sessionKind,
    project_id: input.projectId,
    task_id: input.taskId,
    assignment_id: input.assignmentId,
    run_id: input.runId,
    role,
    audience: input.audience ?? [String(role)],
    mode: input.mode ?? "implementation",
    source_surface: input.sourceSurface ?? "pi_crew",
    user_id: input.userId,
  };
}

export function defaultCaptureMode(context: DenMemoryRuntimeContext): DenMemoryCaptureMode {
  if (context.role === "auditor" || context.session_kind === "diagnostic") return "off";
  if (context.role === "worker" || context.session_kind === "worker_assignment") return "metadata_only";
  return "permissive_candidates";
}

export function registerDenMemoryTools(registry: { registerStatic(tool: DenMemoryToolDefinition): void }, adapter: PiCrewDenMemoryAdapter): void {
  for (const definition of adapter.toolDefinitions()) {
    registry.registerStatic(definition);
  }
}

function candidatePayload(context: DenMemoryRuntimeContext, args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...args,
    created_by: context.agent_identity ?? "pi_crew",
    scope_kind: args.scope_kind ?? (context.project_id ? "project" : "global"),
    scope_id: args.scope_id ?? context.project_id,
    authority_scope_kind: args.authority_scope_kind ?? (context.project_id ? "project" : "global"),
    authority_scope_id: args.authority_scope_id ?? context.project_id,
    discovery_scope: args.discovery_scope ?? "explicit_only",
    claim_strength: args.claim_strength ?? "observation",
    source_refs: args.source_refs ?? defaultSourceRefs(context),
    runtime_context: context,
  };
}

function capturePayload(context: DenMemoryRuntimeContext, captureMode: DenMemoryCaptureMode, args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...args,
    runtime: "pi_crew",
    actor_identity: context.agent_identity ?? "pi_crew",
    actor_role: context.role,
    capture_mode: captureMode,
    scope_kind: args.scope_kind ?? (context.project_id ? "project" : "global"),
    scope_id: args.scope_id ?? context.project_id,
    source_refs: args.source_refs ?? defaultSourceRefs(context),
    runtime_context: context,
  };
}

function defaultSourceRefs(context: DenMemoryRuntimeContext): DenMemorySourceRef[] {
  if (context.task_id !== undefined && context.task_id !== null) {
    return [{
      source_kind: "pi_crew_assignment",
      source_project_id: context.project_id,
      source_id: String(context.assignment_id ?? context.run_id ?? context.task_id),
      source_locator: { task_id: context.task_id, assignment_id: context.assignment_id, run_id: context.run_id, session_id: context.session_id },
      verification_status: "unverified",
    }];
  }
  return [{ source_kind: "pi_crew_session", source_project_id: context.project_id, source_id: context.session_id ?? "unknown", source_locator: {}, verification_status: "unverified" }];
}

function tool(name: DenMemoryToolName, description: string, properties: Record<string, unknown>, required: string[]): DenMemoryToolDefinition {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

function candidateProperties(): Record<string, unknown> {
  return { title: { type: "string" }, body_md: { type: "string" }, summary: { type: "string" }, proposed_kind: { type: "string" }, scope_kind: { type: "string" }, scope_id: { type: "string" }, source_refs: { type: "array", items: { type: "object" } } };
}

function ok(data: unknown): DenMemoryToolCallResult {
  return { ok: true, data };
}
