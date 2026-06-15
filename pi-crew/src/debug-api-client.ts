/** Typed client for pi-crew direct debug/admin diagnostics APIs. */

export interface DebugApiClientConfig {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly adminBearerToken?: string;
}

export interface DebugSessionSummary {
  readonly sessionId: string;
  readonly profileId: string;
  readonly instanceId: string | null;
  readonly kind: string;
  readonly sessionState: string;
  readonly messageCount: number;
  readonly recentErrorCount: number;
  readonly presenceStatus: string;
  readonly classification: string;
  readonly lastActivityAt: string;
  readonly contextPressure?: unknown;
  readonly contextCompaction?: unknown;
}

export interface DebugMessageRecord {
  readonly id: number;
  readonly role: string;
  readonly content: string;
  readonly toolName: string | null;
  readonly tokenCount: number | null;
  readonly createdAt: string;
}

export interface DebugSessionContext {
  readonly sessionId: string;
  readonly limit: number;
  readonly messageCount: number;
  readonly messages: readonly DebugMessageRecord[];
  readonly contextPressure: unknown;
  readonly contextCompaction: unknown;
}

export interface DebugTurnResult {
  readonly sessionId: string;
  readonly turnId: string;
  readonly message: string;
  readonly toolCalls: readonly unknown[];
  readonly delegationHandles: readonly unknown[];
  readonly events: readonly unknown[];
  readonly diagnostics: unknown;
  readonly diagnosticOnly: boolean;
}

export interface DebugEventRecord {
  readonly sequence?: number;
  readonly observedAt?: string;
  readonly event?: string;
  readonly payload?: unknown;
}

export class DebugApiClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DebugApiClientError";
  }
}

export class DebugApiClient {
  readonly #baseUrl: string;
  readonly #fetcher: typeof fetch;
  readonly #adminBearerToken: string | undefined;

  constructor(config: DebugApiClientConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#fetcher = config.fetchImpl ?? fetch;
    this.#adminBearerToken = config.adminBearerToken;
  }

  async listSessions(): Promise<readonly DebugSessionSummary[]> {
    const response = await this.#requestRecord(`${this.#baseUrl}/debug/sessions`);
    return readArray(response["sessions"]).map(readSessionSummary);
  }

  async getSession(sessionId: string): Promise<DebugSessionSummary> {
    return readSessionSummary(
      await this.#requestRecord(`${this.#baseUrl}/debug/sessions/${encodeURIComponent(sessionId)}`),
    );
  }

  async getContext(sessionId: string, limit: number): Promise<DebugSessionContext> {
    const url =
      `${this.#baseUrl}/debug/sessions/${encodeURIComponent(sessionId)}/context?limit=${String(limit)}`;
    return readSessionContext(await this.#requestRecord(url));
  }

  async listEvents(sessionId: string, limit: number): Promise<readonly DebugEventRecord[]> {
    const response = await this.#requestRecord(
      `${this.#baseUrl}/debug/sessions/${encodeURIComponent(sessionId)}/events?limit=${String(limit)}`,
    );
    return readArray(response["events"]).map(readDebugEvent);
  }

  async listTools(sessionId: string): Promise<unknown> {
    const headers = this.#adminBearerToken === undefined ? undefined : {
      Authorization: `Bearer ${this.#adminBearerToken}`,
    };
    return this.#requestRecord(
      `${this.#baseUrl}/admin/diagnostics/tools/${encodeURIComponent(sessionId)}`,
      { headers },
    );
  }

  async postTurn(sessionId: string, message: string, source: string): Promise<DebugTurnResult> {
    return readTurnResult(
      await this.#requestRecord(`${this.#baseUrl}/debug/sessions/${encodeURIComponent(sessionId)}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          contextDiagnostics: true,
          emitDenVisibility: false,
          metadata: { source },
        }),
      }),
    );
  }

  async #requestRecord(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.#fetcher(url, init);
    const text = await response.text();
    const parsed = parseJsonObject(text, url);
    if (!response.ok) {
      throw new DebugApiClientError(`HTTP ${String(response.status)} from ${url}: ${text}`);
    }
    return parsed;
  }
}

function parseJsonObject(text: string, url: string): Record<string, unknown> {
  const parsed = text.trim().length === 0 ? {} : (JSON.parse(text) as unknown);
  if (isRecord(parsed)) return parsed;
  throw new DebugApiClientError(`Expected JSON object from ${url}`);
}

function readSessionSummary(value: unknown): DebugSessionSummary {
  if (!isRecord(value)) throw new DebugApiClientError("Expected session object");
  return {
    sessionId: readString(value, "sessionId"),
    profileId: readString(value, "profileId"),
    instanceId: readNullableString(value, "instanceId"),
    kind: readString(value, "kind"),
    sessionState: readString(value, "sessionState"),
    messageCount: readNumber(value, "messageCount"),
    recentErrorCount: readNumber(value, "recentErrorCount"),
    presenceStatus: readString(value, "presenceStatus"),
    classification: readString(value, "classification"),
    lastActivityAt: readString(value, "lastActivityAt"),
    contextPressure: value["contextPressure"],
    contextCompaction: value["contextCompaction"],
  };
}

function readSessionContext(value: unknown): DebugSessionContext {
  if (!isRecord(value)) throw new DebugApiClientError("Expected session context object");
  return {
    sessionId: readString(value, "sessionId"),
    limit: readNumber(value, "limit"),
    messageCount: readNumber(value, "messageCount"),
    messages: readArray(value["messages"]).map(readDebugMessage),
    contextPressure: value["contextPressure"] ?? null,
    contextCompaction: value["contextCompaction"] ?? null,
  };
}

function readDebugMessage(value: unknown): DebugMessageRecord {
  if (!isRecord(value)) throw new DebugApiClientError("Expected message object");
  return {
    id: readNumber(value, "id"),
    role: readString(value, "role"),
    content: readString(value, "content"),
    toolName: readNullableString(value, "toolName"),
    tokenCount: readNullableNumber(value, "tokenCount"),
    createdAt: readString(value, "createdAt"),
  };
}

function readTurnResult(value: unknown): DebugTurnResult {
  if (!isRecord(value)) throw new DebugApiClientError("Expected turn result object");
  return {
    sessionId: readString(value, "sessionId"),
    turnId: readString(value, "turnId"),
    message: readString(value, "message"),
    toolCalls: readArray(value["toolCalls"]),
    delegationHandles: readArray(value["delegationHandles"]),
    events: readArray(value["events"]),
    diagnostics: value["diagnostics"] ?? null,
    diagnosticOnly: value["diagnosticOnly"] === true,
  };
}

function readDebugEvent(value: unknown): DebugEventRecord {
  if (!isRecord(value)) return { payload: value };
  return {
    sequence: readOptionalNumber(value, "sequence"),
    observedAt: readOptionalString(value, "observedAt"),
    event: readOptionalString(value, "event"),
    payload: value["payload"],
  };
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
