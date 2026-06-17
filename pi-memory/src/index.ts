// pi-memory — Den Memories adapter and dense profile memory for pi-crew.
//
// DESIGN: Den Memories owns the ontology, graph traversal, recall packets,
// curation lifecycle, and persistence.  Dense profile memory is the
// local per-profile pocket notebook (Hermes MEMORY.md / USER.md compat).

export type DenMemoryRuntime = "hermes" | "pi_crew" | "den_core" | "manual" | "import";
export type DenMemorySessionKind = "durable_agent" | "worker_assignment" | "assistant_delegate" | "diagnostic" | "import";
export type DenMemoryRole = "planner" | "runner" | "reviewer" | "worker" | "assistant" | "human" | "auditor";
export type DenMemoryPolicyMode =
  | "off"
  | "metadata_only"
  | "manual"
  | "suggested"
  | "automatic_recall"
  | "candidate_capture"
  | "permissive_candidates";
export type DenMemoryRecallMode = "planning" | "implementation" | "review" | "ops" | "general";
export type DenMemoryToolName = "den_memory_recall" | "den_memory_read" | "den_memory_search" | "den_memory_store" | "den_memory_propose";

export const DEN_MEMORY_TOOL_NAMES: readonly DenMemoryToolName[] = [
  "den_memory_recall",
  "den_memory_read",
  "den_memory_search",
  "den_memory_store",
  "den_memory_propose",
];

export interface DenMemoryRuntimeContext {
  readonly runtime: "pi_crew";
  readonly agent_identity?: string;
  readonly profile_id?: string;
  readonly agent_instance_id?: string;
  readonly session_id?: string;
  readonly session_key?: string;
  readonly session_kind: DenMemorySessionKind;
  readonly project_id?: string;
  readonly task_id?: string | number;
  readonly assignment_id?: string | number | null;
  readonly run_id?: string | null;
  readonly role?: string;
  readonly audience?: readonly string[];
  readonly mode?: DenMemoryRecallMode;
  readonly source_surface?: string;
  readonly user_id?: string;
}

export interface PiCrewMemoryContextInput {
  readonly agentIdentity?: string;
  readonly profileId?: string;
  readonly agentInstanceId?: string;
  readonly sessionId?: string;
  readonly sessionKey?: string;
  readonly sessionKind?: DenMemorySessionKind;
  readonly projectId?: string;
  readonly taskId?: string | number;
  readonly assignmentId?: string | number | null;
  readonly runId?: string | null;
  readonly role?: string;
  readonly audience?: readonly string[];
  readonly mode?: DenMemoryRecallMode;
  readonly sourceSurface?: string;
  readonly userId?: string;
}

export interface DenMemorySourceRef {
  readonly source_kind: string;
  readonly source_project_id?: string | null;
  readonly source_id: string;
  readonly source_locator?: Record<string, unknown>;
  readonly source_summary?: string;
  readonly verification_status?: "unverified" | "verified" | "broken" | "stale";
}

export interface DenMemoryRecallRequest {
  readonly query: string;
  readonly runtime_context: DenMemoryRuntimeContext;
  readonly audience?: readonly string[];
  readonly mode?: DenMemoryRecallMode;
  readonly budget_tokens?: number;
  readonly prefer_relations?: readonly string[];
}

export interface DenMemoryRecallPacket {
  readonly packet_id: string;
  readonly packet_md: string;
  readonly root_matches: readonly Record<string, unknown>[];
  readonly included_nodes: readonly Record<string, unknown>[];
  readonly included_edges?: readonly Record<string, unknown>[];
  readonly skipped: readonly Record<string, unknown>[];
  readonly warnings: readonly string[];
  readonly provenance: readonly Record<string, unknown>[];
}

export interface DenMemoryToolDefinition {
  readonly name: DenMemoryToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface DenMemoryToolCallResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly code?: string;
  readonly status?: number;
  readonly toolName?: string;
}

export interface DenMemoryClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

export class DenMemoryClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(message: string, input: { readonly code: string; readonly status?: number; readonly cause?: unknown }) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "DenMemoryClientError";
    this.code = input.code;
    this.status = input.status;
  }
}

export class DenMemoryClient {
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(options: DenMemoryClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  recall(request: DenMemoryRecallRequest): Promise<DenMemoryRecallPacket> {
    return this.#requestJson<DenMemoryRecallPacket>("POST", "/api/recall", request);
  }

  read(slug: string): Promise<unknown> {
    return this.#requestJson("GET", `/api/memory-entries/${encodeURIComponent(slug)}`);
  }

  search(request: Record<string, unknown>): Promise<unknown> {
    return this.#requestJson("POST", "/api/memory-entries/search", request);
  }

  store(request: Record<string, unknown>): Promise<unknown> {
    return this.#requestJson("POST", "/api/memory-entries", request);
  }

  storeCandidate(request: Record<string, unknown>): Promise<unknown> {
    return this.#requestJson("POST", "/api/candidates", request);
  }

  async #requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.#requestTimeoutMs);
    try {
      const response = await this.#fetchImpl(new URL(`${this.#baseUrl}${path}`), {
        method,
        headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new DenMemoryClientError(`Den Memories HTTP ${String(response.status)}: ${text}`, { code: "http_error", status: response.status });
      }
      return (text.length === 0 ? {} : JSON.parse(text)) as T;
    } catch (error: unknown) {
      if (error instanceof DenMemoryClientError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new DenMemoryClientError(`Den Memories request failed: ${message}`, { code: "request_failed", cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface DenMemoryAdapterOptions {
  readonly client: DenMemoryClient;
  readonly runtimeContext: DenMemoryRuntimeContext;
  readonly policyMode?: DenMemoryPolicyMode;
}

export class PiCrewDenMemoryAdapter {
  readonly client: DenMemoryClient;
  readonly runtimeContext: DenMemoryRuntimeContext;
  readonly policyMode: DenMemoryPolicyMode;

  constructor(options: DenMemoryAdapterOptions) {
    this.client = options.client;
    this.runtimeContext = options.runtimeContext;
    this.policyMode = options.policyMode ?? defaultPolicyMode(options.runtimeContext);
  }

  static fromContext(client: DenMemoryClient, input: PiCrewMemoryContextInput): PiCrewDenMemoryAdapter {
    return new PiCrewDenMemoryAdapter({ client, runtimeContext: createPiCrewRuntimeContext(input) });
  }

  promptHeading(): string {
    return "Den Memories: explicit/manual tools only by default; recall returns bounded packets, and candidate writes do not promote curated memory.";
  }

  toolDefinitions(): readonly DenMemoryToolDefinition[] {
    return [
      tool("den_memory_recall", "Read-only guided Den Memories recall packet with provenance and skipped-node reasons.", recallProperties(), ["query"]),
      tool("den_memory_read", "Read one Den Memories entry by slug; use only when you already have a memory handle.", { slug: stringSchema("Memory entry slug.") }, ["slug"]),
      tool("den_memory_search", "Search Den Memories entries/candidates; recall is preferred for guided context.", searchProperties(), ["query"]),
      tool("den_memory_store", "Store a curated Den Memories entry directly (auto-promotes). For full agents that can create durable memory without curator review.", storeProperties(), ["title", "body_md", "proposed_kind"]),
      tool("den_memory_propose", "Propose a candidate memory for curator review; never promotes. For workers and explicit staging where curation review is required.", candidateProperties(), ["title", "body_md", "proposed_kind"]),
    ];
  }

  async callTool(name: DenMemoryToolName, args: Record<string, unknown> = {}): Promise<DenMemoryToolCallResult> {
    if (this.policyMode === "off") return { ok: false, error: "Den Memories policy is off", code: "policy_off", toolName: name };
    if (name === "den_memory_propose" && !policyAllowsCandidateStore(this.policyMode)) {
      return { ok: false, error: `Den Memories policy ${this.policyMode} does not allow candidate storage`, code: "policy_candidate_store_denied", toolName: name };
    }
    if (name === "den_memory_store" && !policyAllowsStore(this.policyMode, this.runtimeContext)) {
      return { ok: false, error: `Den Memories policy ${this.policyMode} does not allow direct store for session kind ${this.runtimeContext.session_kind}`, code: "policy_store_denied", toolName: name };
    }
    try {
      switch (name) {
        case "den_memory_recall":
          return ok(await this.client.recall(recallPayload(this.runtimeContext, args)));
        case "den_memory_read":
          return ok(await this.client.read(String(args.slug)));
        case "den_memory_search":
          return ok(await this.client.search(searchPayload(this.runtimeContext, args)));
        case "den_memory_store":
          return ok(await this.client.store(storePayload(this.runtimeContext, args)));
        case "den_memory_propose":
          return ok(await this.client.storeCandidate(candidatePayload(this.runtimeContext, args)));
      }
    } catch (error: unknown) {
      return errorResult(name, error);
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
    audience: input.audience ?? [role],
    mode: input.mode ?? (role === "reviewer" ? "review" : "implementation"),
    source_surface: input.sourceSurface ?? "pi_crew",
    user_id: input.userId,
  };
}

export function defaultPolicyMode(context: DenMemoryRuntimeContext): DenMemoryPolicyMode {
  if (context.session_kind === "worker_assignment" || context.session_kind === "assistant_delegate") return "metadata_only";
  return "manual";
}

function policyAllowsCandidateStore(policyMode: DenMemoryPolicyMode): boolean {
  return policyMode === "candidate_capture" || policyMode === "permissive_candidates";
}

function policyAllowsStore(policyMode: DenMemoryPolicyMode, context: DenMemoryRuntimeContext): boolean {
  if (policyMode === "off") return false;
  if (context.session_kind === "worker_assignment" || context.session_kind === "assistant_delegate") return false;
  return policyMode === "permissive_candidates" || policyMode === "manual" || policyMode === "suggested" || policyMode === "automatic_recall";
}

export function registerDenMemoryTools(registry: { registerStatic(tool: DenMemoryToolDefinition): void }, adapter: PiCrewDenMemoryAdapter): void {
  for (const definition of adapter.toolDefinitions()) registry.registerStatic(definition);
}

export function defaultSourceRefs(context: DenMemoryRuntimeContext): readonly DenMemorySourceRef[] {
  if (context.assignment_id !== undefined && context.assignment_id !== null) {
    return [{
      source_kind: "pi_crew_assignment",
      source_project_id: context.project_id,
      source_id: String(context.assignment_id),
      source_locator: { task_id: context.task_id, assignment_id: context.assignment_id, run_id: context.run_id, session_id: context.session_id },
      verification_status: "unverified",
    }];
  }
  if (context.task_id !== undefined) {
    return [{ source_kind: "den_task", source_project_id: context.project_id, source_id: String(context.task_id), source_locator: { session_id: context.session_id }, verification_status: "unverified" }];
  }
  return [{ source_kind: "pi_crew_session", source_project_id: context.project_id, source_id: context.session_id ?? "unknown", source_locator: {}, verification_status: "unverified" }];
}

function recallPayload(context: DenMemoryRuntimeContext, args: Record<string, unknown>): DenMemoryRecallRequest {
  return {
    query: normalizeMemoryQuery(String(args.query)),
    runtime_context: context,
    audience: arrayArg(args.audience) ?? context.audience,
    mode: modeArg(args.mode) ?? context.mode,
    budget_tokens: numberArg(args.budget_tokens ?? args.budgetTokens),
    prefer_relations: arrayArg(args.prefer_relations ?? args.preferRelations),
  };
}

function searchPayload(context: DenMemoryRuntimeContext, args: Record<string, unknown>): Record<string, unknown> {
  return { query: normalizeMemoryQuery(String(args.query)), limit: args.limit ?? 10, runtime_context: context, audience: args.audience ?? context.audience };
}

function candidatePayload(context: DenMemoryRuntimeContext, args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...args,
    created_by: context.agent_identity ?? "pi_crew",
    scope_kind: args.scope_kind ?? (context.project_id === undefined ? "global" : "project"),
    scope_id: args.scope_id ?? context.project_id,
    curation_state: "candidate",
    source_refs: args.source_refs ?? defaultSourceRefs(context),
    runtime_context: context,
  };
}

function storePayload(context: DenMemoryRuntimeContext, args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...args,
    created_by: context.agent_identity ?? "pi_crew",
    scope_kind: args.scope_kind ?? (context.project_id === undefined ? "global" : "project"),
    scope_id: args.scope_id ?? context.project_id,
    curation_state: "curated",
    source_refs: args.source_refs ?? defaultSourceRefs(context),
    runtime_context: context,
  };
}

function normalizeMemoryQuery(query: string): string {
  return query.replace(/(?<=\p{L}|\p{N})-(?=\p{L}|\p{N})/gu, " ");
}

function tool(name: DenMemoryToolName, description: string, properties: Record<string, unknown>, required: readonly string[]): DenMemoryToolDefinition {
  return { name, description, inputSchema: { type: "object", additionalProperties: false, properties, required } };
}

function recallProperties(): Record<string, unknown> {
  return { query: stringSchema("Recall query."), audience: arraySchema(), mode: stringSchema("Recall mode."), budget_tokens: numberSchema(), prefer_relations: arraySchema() };
}

function searchProperties(): Record<string, unknown> {
  return { query: stringSchema("Search query."), audience: arraySchema(), limit: numberSchema() };
}

function candidateProperties(): Record<string, unknown> {
  return { title: stringSchema("Candidate title."), body_md: stringSchema("Candidate body markdown."), summary: stringSchema("Short candidate summary."), proposed_kind: stringSchema("Memory kind proposed for curator review."), scope_kind: stringSchema("Optional scope kind."), scope_id: stringSchema("Optional scope id."), source_refs: { type: "array", items: { type: "object" } } };
}

function storeProperties(): Record<string, unknown> {
  return { title: stringSchema("Memory entry title."), body_md: stringSchema("Memory entry body markdown."), summary: stringSchema("Short summary."), proposed_kind: stringSchema("Memory kind."), scope_kind: stringSchema("Optional scope kind."), scope_id: stringSchema("Optional scope id."), source_refs: { type: "array", items: { type: "object" } } };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberSchema(): Record<string, unknown> {
  return { type: "number" };
}

function arraySchema(): Record<string, unknown> {
  return { type: "array", items: { type: "string" } };
}

function arrayArg(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function modeArg(value: unknown): DenMemoryRecallMode | undefined {
  if (typeof value !== "string") return undefined;
  if (["planning", "implementation", "review", "ops", "general"].includes(value)) return value as DenMemoryRecallMode;
  return undefined;
}

function ok(data: unknown): DenMemoryToolCallResult {
  return { ok: true, data };
}

function errorResult(toolName: DenMemoryToolName, error: unknown): DenMemoryToolCallResult {
  if (error instanceof DenMemoryClientError) return { ok: false, error: error.message, code: error.code, status: error.status, toolName };
  return { ok: false, error: error instanceof Error ? error.message : String(error), code: "unexpected_error", toolName };
}

// ── Dense profile memory re-exports ────────────────────────────

export type {
  DenseMemoryTarget,
  DenseMemoryAction,
  DenseMemoryContent,
  DenseMemoryWriteParams,
  DenseMemoryWriteResult,
  DenseProfileMemoryStore,
} from "./dense-profile-memory-types.js";

export {
  DEFAULT_MEMORY_CAP_BYTES,
  DEFAULT_USER_CAP_BYTES,
  parseEntries,
  buildContent,
  byteLength,
  findEntryBySubstring,
  trimToCap,
} from "./dense-profile-memory-types.js";
