import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export interface DenChannelReadbackToolConfig {
  readonly baseUrl: string;
  readonly allowedChannelIds: readonly string[];
  readonly token?: string;
  readonly fetchFn?: typeof fetch;
  readonly maxLimit?: number;
}

interface ReadbackRequest {
  readonly channelId?: string;
  readonly limit?: number;
}

interface ReadbackItem {
  readonly id: number | string;
  readonly kind: "message" | "activity";
  readonly title: string;
  readonly summary: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly childSessionId?: string;
  readonly createdAt?: string;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LIMIT = 50;
const MAX_TEXT_CHARS = 600;

export function createDenChannelReadbackTool(config: DenChannelReadbackToolConfig): AgentTool {
  return {
    label: "Read recent Den channel evidence",
    name: "den_channels_read_recent",
    description: "Read a bounded recent window of Den Channels messages and activity events for an allowed current channel. Use this to verify channel-visible projection evidence such as delegation.tool_visible.",
    parameters: Type.Object({
      channelId: Type.Optional(Type.String({ description: "Allowed Den channel id. Defaults to the only configured channel when there is one." })),
      limit: Type.Optional(Type.Number({ description: "Maximum recent messages and activity events to return. Capped by policy." })),
    }),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<string>> => {
      const request = readRequest(params);
      const channelId = request.channelId ?? singleAllowedChannel(config.allowedChannelIds);
      if (channelId === null || !config.allowedChannelIds.includes(channelId)) {
        return textResult("Den channel readback denied: channel is not allowed for this session.", {
          ok: false,
          error: "channel_not_allowed",
          channelId: channelId ?? request.channelId ?? null,
        });
      }
      const limit = boundedLimit(request.limit, config.maxLimit ?? DEFAULT_MAX_LIMIT);
      const fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
      const [messages, activity] = await Promise.all([
        fetchItems(fetchFn, readUrl(config.baseUrl, channelId, "messages", limit), config.token, signal, "message"),
        fetchItems(fetchFn, readUrl(config.baseUrl, channelId, "activity-events", limit), config.token, signal, "activity"),
      ]);
      const items = [...messages, ...activity].slice(0, limit * 2);
      return textResult(formatItems(channelId, limit, items), {
        ok: true,
        channelId,
        limit,
        messageCount: messages.length,
        activityCount: activity.length,
      });
    },
  };
}

function readRequest(params: unknown): ReadbackRequest {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return {};
  const record = params as Record<string, unknown>;
  return {
    channelId: typeof record.channelId === "string" ? record.channelId : undefined,
    limit: typeof record.limit === "number" ? record.limit : undefined,
  };
}

function singleAllowedChannel(channelIds: readonly string[]): string | null {
  return channelIds.length === 1 ? channelIds[0] ?? null : null;
}

function boundedLimit(value: number | undefined, maxLimit: number): number {
  if (value === undefined || !Number.isFinite(value)) return Math.min(DEFAULT_LIMIT, maxLimit);
  return Math.max(1, Math.min(Math.floor(value), maxLimit));
}

function readUrl(baseUrl: string, channelId: string, path: "messages" | "activity-events", limit: number): string {
  const url = new URL(`/api/channels/${encodeURIComponent(channelId)}/${path}`, normalizedBaseUrl(baseUrl));
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

async function fetchItems(
  fetchFn: typeof fetch,
  url: string,
  token: string | undefined,
  signal: AbortSignal | undefined,
  kind: "message" | "activity",
): Promise<ReadbackItem[]> {
  const response = await fetchFn(url, { headers: tokenHeaders(token), signal });
  if (!response.ok) return [];
  const payload: unknown = await response.json();
  return extractArray(payload).map((item) => normalizeItem(item, kind)).filter(isReadbackItem);
}

function tokenHeaders(token: string | undefined): Record<string, string> {
  return token === undefined || token.length === 0 ? {} : { Authorization: `Bearer ${token}` };
}

function extractArray(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["items", "messages", "events"] as const) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeItem(item: unknown, kind: "message" | "activity"): ReadbackItem | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  const metadata = parseObject(firstString(record.metadataJson, record.metadata_json));
  const id = firstId(record.id, record.messageId, record.eventId);
  if (id === null) return null;
  return {
    id,
    kind,
    title: firstString(record.eventType, record.event_type, record.title, metadata.toolName, metadata.tool_name, record.messageKind, record.message_kind) ?? kind,
    summary: truncate(firstString(record.summary, record.body, record.text, record.content, record.preview) ?? "", MAX_TEXT_CHARS),
    toolName: firstString(metadata.toolName, metadata.tool_name),
    toolCallId: firstString(metadata.toolCallId, metadata.tool_call_id, record.toolCallId, record.tool_call_id),
    childSessionId: firstString(metadata.childSessionId, metadata.child_session_id, record.childSessionId, record.child_session_id),
    createdAt: firstString(record.createdAt, record.created_at),
  };
}

function isReadbackItem(item: ReadbackItem | null): item is ReadbackItem {
  return item !== null;
}

function parseObject(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstId(...values: readonly unknown[]): number | string | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function formatItems(channelId: string, limit: number, items: readonly ReadbackItem[]): string {
  if (items.length === 0) return `No recent Den channel evidence found for channel ${channelId} (limit ${String(limit)}).`;
  const lines = [`Recent Den channel evidence for channel ${channelId} (limit ${String(limit)}):`];
  for (const item of items) {
    lines.push(formatItem(item));
  }
  return lines.join("\n");
}

function formatItem(item: ReadbackItem): string {
  const details = [
    item.toolName === undefined ? null : `tool=${item.toolName}`,
    item.toolCallId === undefined ? null : `toolCallId=${item.toolCallId}`,
    item.childSessionId === undefined ? null : `childSessionId=${item.childSessionId}`,
  ].filter((value): value is string => value !== null).join(", ");
  const suffix = details.length > 0 ? ` (${details})` : "";
  const at = item.createdAt === undefined ? "" : ` ${item.createdAt}`;
  return `- ${item.kind} #${String(item.id)}${at}: ${item.title}${suffix}${item.summary.length > 0 ? ` — ${item.summary}` : ""}`;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<string> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
