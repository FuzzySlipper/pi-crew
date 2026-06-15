import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { MessageRow, SessionSearchRepository } from "@pi-crew/service";

export interface SessionSearchToolInput {
  readonly profileId: string;
  readonly repository: SessionSearchRepository;
}

interface SessionSearchMessageView {
  readonly id: number;
  readonly session_id: string;
  readonly role: MessageRow["role"];
  readonly content: string;
  readonly tool_name: string | null;
  readonly created_at: string;
}

interface DiscoveryResult {
  readonly session_id: string;
  readonly profile_id: string;
  readonly snippet: string;
  readonly match_message_id: number;
  readonly messages: readonly SessionSearchMessageView[];
  readonly bookend_start: readonly SessionSearchMessageView[];
  readonly bookend_end: readonly SessionSearchMessageView[];
}

const DEFAULT_DISCOVERY_LIMIT = 5;
const DEFAULT_BROWSE_LIMIT = 10;
const DEFAULT_WINDOW = 5;
const MAX_LIMIT = 25;
const MAX_WINDOW = 20;

export function createSessionSearchTool(input: SessionSearchToolInput): AgentTool {
  return {
    label: "Session search",
    name: "session_search",
    description:
      "Search profile-bounded past session messages. Pass query for FTS discovery with snippets/bookends, pass session_id plus around_message_id to scroll, or omit args to browse recent sessions. Never crosses profile boundaries.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "FTS5 query for discovery mode." },
        limit: { type: "number", default: DEFAULT_DISCOVERY_LIMIT },
        session_id: { type: "string", description: "Session id for scroll/read mode." },
        around_message_id: { type: "number", description: "Anchor message id for scroll mode." },
        window: { type: "number", default: DEFAULT_WINDOW },
      },
      required: [],
    },
    execute: async (_toolCallId, params) => {
      const record = objectParam(params);
      const query = optionalString(record, "query");
      const sessionId = optionalString(record, "session_id");
      const around = optionalNumber(record, "around_message_id");
      if (query !== undefined) return discovery(input, query, boundedNumber(record, "limit", DEFAULT_DISCOVERY_LIMIT, MAX_LIMIT));
      if (sessionId !== undefined && around !== undefined) {
        return scroll(input, sessionId, around, boundedNumber(record, "window", DEFAULT_WINDOW, MAX_WINDOW));
      }
      return browse(input, boundedNumber(record, "limit", DEFAULT_BROWSE_LIMIT, MAX_LIMIT));
    },
  };
}

async function discovery(
  input: SessionSearchToolInput,
  query: string,
  limit: number,
): Promise<{ readonly content: readonly [{ readonly type: "text"; readonly text: string }]; readonly details: unknown }> {
  const hits = await input.repository.searchProfile(input.profileId, query, limit);
  const bySession = new Map<string, DiscoveryResult>();
  for (const hit of hits) {
    if (bySession.has(hit.message.session_id)) continue;
    const sessionMessages = await input.repository.getSessionMessagesForProfile(
      input.profileId,
      hit.message.session_id,
      1_000,
    );
    const messages = await input.repository.getWindowForProfile(
      input.profileId,
      hit.message.session_id,
      hit.message.id,
      DEFAULT_WINDOW,
    );
    bySession.set(hit.message.session_id, {
      session_id: hit.message.session_id,
      profile_id: hit.profileId,
      snippet: hit.snippet,
      match_message_id: hit.message.id,
      messages: messages.map(messageView),
      bookend_start: sessionMessages.slice(0, 3).map(messageView),
      bookend_end: sessionMessages.slice(-3).map(messageView),
    });
  }
  return toolResult({ mode: "discovery", profile_id: input.profileId, results: [...bySession.values()] });
}

async function scroll(
  input: SessionSearchToolInput,
  sessionId: string,
  aroundMessageId: number,
  window: number,
): Promise<{ readonly content: readonly [{ readonly type: "text"; readonly text: string }]; readonly details: unknown }> {
  const messages = await input.repository.getWindowForProfile(
    input.profileId,
    sessionId,
    aroundMessageId,
    window,
  );
  return toolResult({
    mode: "scroll",
    profile_id: input.profileId,
    session_id: sessionId,
    around_message_id: aroundMessageId,
    messages: messages.map(messageView),
  });
}

async function browse(
  input: SessionSearchToolInput,
  limit: number,
): Promise<{ readonly content: readonly [{ readonly type: "text"; readonly text: string }]; readonly details: unknown }> {
  const sessions = await input.repository.browseProfile(input.profileId, limit);
  return toolResult({
    mode: "browse",
    profile_id: input.profileId,
    sessions: sessions.map((session) => ({
      session_id: session.sessionId,
      profile_id: session.profileId,
      last_activity: session.lastActivity,
      preview: session.preview === null ? null : messageView(session.preview),
    })),
  });
}

function messageView(row: MessageRow): SessionSearchMessageView {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: readableContent(row.content),
    tool_name: row.tool_name,
    created_at: row.created_at,
  };
}

function readableContent(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) return parsed.map(partToText).filter(Boolean).join("\n");
    if (typeof parsed === "object" && parsed !== null) return JSON.stringify(parsed);
  } catch {
    return raw;
  }
  return raw;
}

function partToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  return typeof record.text === "string" ? record.text : "";
}

function toolResult(details: unknown): {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly details: unknown;
} {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

function objectParam(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function optionalString(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
  return value;
}

function boundedNumber(
  record: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = optionalNumber(record, name) ?? fallback;
  return Math.max(1, Math.min(value, max));
}
