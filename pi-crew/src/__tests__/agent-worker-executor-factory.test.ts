import { describe, expect, it } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import { ToolRegistry, type AgentTool as McpAgentTool, type MCPClient } from "@pi-crew/mcp";
import type { AgentWorkerToolProviderInput } from "@pi-crew/service";

import { createCrewAgentWorkerToolProvider } from "../agent-worker-executor-factory.js";

function mcpTool(name: string): McpAgentTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
  };
}

function makeInput(toolSets: readonly string[]): AgentWorkerToolProviderInput {
  return {
    toolSets,
    roleInput: {
      binding: {
        assignmentId: "assignment-1",
        runId: "run-1",
        taskId: "2155",
        projectId: "pi-crew",
        role: "coder",
      },
      sessionId: "session-1",
      profileId: "spawned-coder",
    },
  };
}

function makeClient(): MCPClient {
  const client = {
    callTool: () => Promise.resolve({
      ok: true,
      content: [{ type: "text", text: "ok" }],
    }),
  };
  return client as unknown as MCPClient;
}

describe("createCrewAgentWorkerToolProvider", () => {
  it("keeps static control tools but restricts den set to safe read-only MCP tools", () => {
    const registry = new ToolRegistry(new FakeLogger());
    registry.setMcpTools([
      mcpTool("mcp_den_get_task"),
      mcpTool("mcp_den_delete_document"),
      mcpTool("mcp_den_upsert_pool_member"),
      mcpTool("mcp_den_query_librarian"),
      mcpTool("all_dangerous"),
    ]);
    const provider = createCrewAgentWorkerToolProvider({
      mcpClient: makeClient(),
      toolRegistry: registry,
      logger: new FakeLogger(),
    });

    const toolNames = provider(makeInput(["den"])).map((tool) => tool.name);

    expect(toolNames).toContain("post_structured_completion");
    expect(toolNames).toContain("context_status");
    expect(toolNames).toContain("mcp_den_get_task");
    expect(toolNames).toContain("mcp_den_query_librarian");
    expect(toolNames).not.toContain("mcp_den_delete_document");
    expect(toolNames).not.toContain("mcp_den_upsert_pool_member");

    const allToolNames = provider(makeInput(["all"])).map((tool) => tool.name);
    expect(allToolNames).toEqual(["post_structured_completion", "context_status"]);
    const uppercaseAllToolNames = provider(makeInput(["ALL", "All"])).map((tool) => tool.name);
    expect(uppercaseAllToolNames).toEqual(["post_structured_completion", "context_status"]);
  });
});
