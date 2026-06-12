import { describe, expect, it, vi } from "vitest";

import { createDenChannelReadbackTool } from "../den-channel-readback-tool.js";

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe("Den channel readback tool", () => {
  it("reads bounded current-channel messages and activity evidence", async () => {
    const seenUrls: string[] = [];
    const fetchFn = vi.fn((input: string | URL) => {
      const url = input instanceof URL ? input.toString() : input;
      seenUrls.push(url);
      if (url.includes("/messages")) {
        return Promise.resolve(response({
          messages: [{
            id: 4791,
            messageKind: "agent_text",
            senderIdentity: "conv-orchestrator-test",
            body: "**delegation.tool_visible**\nSubagent tool called: get_task_workflow_summary\ntoolCallId: tool-1",
            createdAt: "2026-06-12T09:00:00Z",
          }],
        }));
      }
      return Promise.resolve(response({
        items: [{
          id: 901,
          eventType: "delegation.tool_visible",
          title: "get_task_workflow_summary",
          summary: "Subagent used tool: get_task_workflow_summary completed (20ms)",
          metadataJson: JSON.stringify({ toolName: "get_task_workflow_summary", toolCallId: "tool-1", childSessionId: "delegated-session-1" }),
          createdAt: "2026-06-12T09:00:01Z",
        }],
      }));
    });
    const tool = createDenChannelReadbackTool({
      baseUrl: "http://192.168.1.10:18081",
      allowedChannelIds: ["642"],
      fetchFn: fetchFn as unknown as typeof fetch,
      maxLimit: 5,
    });

    const result = await tool.execute("call-1", { channelId: "642", limit: 20 }, new AbortController().signal);

    expect(seenUrls).toEqual([
      "http://192.168.1.10:18081/api/channels/642/messages?limit=5",
      "http://192.168.1.10:18081/api/channels/642/activity-events?limit=5",
    ]);
    expect(result.content[0]?.text).toContain("message #4791");
    expect(result.content[0]?.text).toContain("activity #901");
    expect(result.content[0]?.text).toContain("get_task_workflow_summary");
    expect(result.content[0]?.text).toContain("tool-1");
    expect(result.content[0]?.text).toContain("delegated-session-1");
    expect(result.details).toMatchObject({ ok: true, channelId: "642", limit: 5 });
  });

  it("rejects cross-channel reads", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(response({ messages: [] })));
    const tool = createDenChannelReadbackTool({
      baseUrl: "http://192.168.1.10:18081",
      allowedChannelIds: ["642"],
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await tool.execute("call-2", { channelId: "999" }, new AbortController().signal);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("not allowed");
    expect(result.details).toMatchObject({ ok: false, error: "channel_not_allowed" });
  });
});
