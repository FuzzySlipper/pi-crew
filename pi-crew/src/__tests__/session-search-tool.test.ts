import { describe, expect, it } from "vitest";
import type {
  MessageRow,
  SessionSearchBrowseRow,
  SessionSearchHit,
  SessionSearchRepository,
} from "@pi-crew/service";
import { createSessionSearchTool } from "../session-search-tool.js";

class FakeSessionSearchRepository implements SessionSearchRepository {
  readonly messages: readonly MessageRow[] = [
    row(1, "sess-a", "user", "start alpha"),
    row(2, "sess-a", "assistant", "middle alpha"),
    row(3, "sess-a", "assistant", "end alpha"),
    row(4, "sess-b", "user", "other beta"),
  ];

  searchProfile(profileId: string, query: string, limit = 5): Promise<SessionSearchHit[]> {
    return Promise.resolve(this.messages
      .filter((message) => message.content.includes(query))
      .slice(0, limit)
      .map((message) => ({ message, profileId, snippet: `[${query}]` })));
  }

  getSessionMessagesForProfile(
    _profileId: string,
    sessionId: string,
    limit = 500,
  ): Promise<MessageRow[]> {
    return Promise.resolve(this.messages.filter((message) => message.session_id === sessionId).slice(0, limit));
  }

  getWindowForProfile(
    _profileId: string,
    sessionId: string,
    aroundMessageId: number,
    window: number,
  ): Promise<MessageRow[]> {
    const scoped = this.messages.filter((message) => message.session_id === sessionId);
    const index = scoped.findIndex((message) => message.id === aroundMessageId);
    const start = Math.max(0, index - window);
    return Promise.resolve(scoped.slice(start, index + window + 1));
  }

  browseProfile(profileId: string, limit = 10): Promise<SessionSearchBrowseRow[]> {
    return Promise.resolve([
      { sessionId: "sess-a", profileId, lastActivity: "2026-01-01T00:00:00Z", preview: this.messages[2] ?? null },
    ].slice(0, limit));
  }
}

interface SearchToolJsonResult {
  readonly mode: string;
  readonly results?: readonly Array<{
    readonly session_id: string;
    readonly messages: readonly Array<{ readonly id: number }>;
    readonly bookend_start: readonly unknown[];
  }>;
  readonly messages?: readonly Array<{ readonly id: number }>;
  readonly sessions?: readonly Array<{ readonly session_id: string }>;
}

describe("session_search tool", () => {
  it("discovers sessions with match windows and bookends", async () => {
    const result = await execute({ query: "alpha" });
    expect(result.mode).toBe("discovery");
    expect(result.results).toHaveLength(1);
    expect(result.results?.[0]?.session_id).toBe("sess-a");
    expect(result.results?.[0]?.messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(result.results?.[0]?.bookend_start).toHaveLength(3);
  });

  it("scrolls around a message id", async () => {
    const result = await execute({ session_id: "sess-a", around_message_id: 2, window: 1 });
    expect(result.mode).toBe("scroll");
    expect(result.messages?.map((message) => message.id)).toEqual([1, 2, 3]);
  });

  it("browses recent sessions when called without args", async () => {
    const result = await execute({});
    expect(result.mode).toBe("browse");
    expect(result.sessions?.[0]?.session_id).toBe("sess-a");
  });
});

async function execute(params: Record<string, unknown>): Promise<SearchToolJsonResult> {
  const tool = createSessionSearchTool({ profileId: "profile-a", repository: new FakeSessionSearchRepository() });
  const result = await tool.execute("call", params);
  const content = result.content[0] as { readonly text?: string } | undefined;
  return JSON.parse(content?.text ?? "{}") as SearchToolJsonResult;
}

function row(
  id: number,
  sessionId: string,
  role: MessageRow["role"],
  content: string,
): MessageRow {
  return {
    id,
    session_id: sessionId,
    role,
    content: JSON.stringify(content),
    tool_name: null,
    token_count: null,
    created_at: `2026-01-01T00:00:0${String(id)}Z`,
  };
}
