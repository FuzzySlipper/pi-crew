import { describe, expect, it } from "vitest";
import type { MCPClient, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";

import { createFullAgentMcpAgentTool } from "../full-agent-mcp-tool.js";

describe("createFullAgentMcpAgentTool", () => {
  it("preserves MCP input schema properties while allowing runtime-defaulted Den arguments", () => {
    const schema = {
      type: "object",
      required: ["project_id", "sender", "content"],
      properties: { sender: { type: "string" }, content: { type: "string" } },
    };
    const tool = createFullAgentMcpAgentTool(mcpTool("send_message", schema), makeClient(), {
      sender: "pi-orchestrator",
      projectId: "pi-crew",
    });

    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["content"],
      properties: schema.properties,
    });
  });

  it("fills sender and project_id defaults for Den write tools", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createFullAgentMcpAgentTool(
      mcpTool("send_message", { type: "object" }),
      makeClient(calls),
      { sender: "pi-orchestrator", projectId: "pi-crew" },
    );

    await tool.execute("call-1", { task_id: 2360, content: "hello" }, new AbortController().signal);

    expect(calls).toEqual([
      { task_id: 2360, content: "hello", sender: "pi-orchestrator", project_id: "pi-crew" },
    ]);
  });

  it("does not overwrite explicit Den sender/project arguments", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createFullAgentMcpAgentTool(
      mcpTool("post_review_findings", { type: "object" }),
      makeClient(calls),
      { sender: "pi-orchestrator", projectId: "pi-crew" },
    );

    await tool.execute(
      "call-1",
      { task_id: 2360, review_round_id: 1, sender: "reviewer", project_id: "other" },
      new AbortController().signal,
    );

    expect(calls).toEqual([
      { task_id: 2360, review_round_id: 1, sender: "reviewer", project_id: "other" },
    ]);
  });

  it("leaves read-only tools unchanged", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createFullAgentMcpAgentTool(
      mcpTool("get_task", { type: "object" }),
      makeClient(calls),
      { sender: "pi-orchestrator", projectId: "pi-crew" },
    );

    await tool.execute("call-1", { task_id: 2360 }, new AbortController().signal);

    expect(calls).toEqual([{ task_id: 2360 }]);
  });
});

function mcpTool(
  name: string,
  inputSchema: ReturnType<McpToolRegistry["listTools"]>[number]["inputSchema"],
): ReturnType<McpToolRegistry["listTools"]>[number] {
  return { name, description: `${name} description`, inputSchema };
}

function makeClient(calls: Array<Record<string, unknown>> = []): MCPClient {
  return {
    callTool: (_toolName: string, params: Record<string, unknown>) => {
      calls.push(params);
      return Promise.resolve({ ok: true, content: [{ type: "text", text: "ok" }] });
    },
  } as unknown as MCPClient;
}
