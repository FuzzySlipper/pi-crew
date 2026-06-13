import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolProvider } from "@pi-crew/service";
import type { MCPClient, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import type { ToolCallContentBlock } from "@pi-crew/mcp";
import { createLocalCodeTools, localCodeToolNames } from "./local-code-tools.js";

export interface DelegatedChildToolProviderDeps {
  readonly mcpClient: MCPClient;
  readonly toolRegistry: McpToolRegistry;
}

export function createDelegatedChildToolProvider(
  deps: DelegatedChildToolProviderDeps,
): ToolProvider {
  return new McpDelegatedChildToolProvider(deps);
}

class McpDelegatedChildToolProvider implements ToolProvider {
  constructor(private readonly deps: DelegatedChildToolProviderDeps) {}

  resolveTools(toolNames: readonly string[]): AgentTool[] {
    const requested = expandToolNames(toolNames);
    const unique = [...new Set(requested)];
    const localTools = createLocalCodeTools().filter((tool) => unique.includes(tool.name));
    const mcpTools = this.deps.toolRegistry
      .listTools()
      .filter((tool) => unique.includes(tool.name))
      .map(
        (tool) =>
          ({
            label: tool.name,
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            execute: async (_toolCallId: string, params: unknown) => {
              const result = await this.deps.mcpClient.callTool(tool.name, paramsToRecord(params));
              if (!result.ok) {
                return {
                  content: [{ type: "text", text: result.error ?? "MCP tool call failed" }],
                  details: { ok: false, error: result.error },
                };
              }
              return {
                content: result.content.map(contentBlockToText),
                details: { ok: true },
              };
            },
          }) as AgentTool,
      );
    return [...localTools, ...mcpTools];
  }
}

function expandToolNames(toolNames: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const name of toolNames) {
    if (name === "den") {
      expanded.push(...safeDenToolNames);
      continue;
    }
    if (name === "delegation") continue;
    expanded.push(name);
  }
  return expanded;
}

function paramsToRecord(params: unknown): Record<string, unknown> {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

function contentBlockToText(block: ToolCallContentBlock): { type: "text"; text: string } {
  if (block.type === "text") return { type: "text", text: block.text };
  return { type: "text", text: JSON.stringify(block) };
}

const safeDenToolNames = [
  "mcp_den_get_task",
  "mcp_den_get_thread",
  "mcp_den_get_messages",
  "mcp_den_get_latest_task_packet",
  "mcp_den_get_latest_worker_completion",
  "mcp_den_get_task_workflow_summary",
  "mcp_den_get_document",
  "mcp_den_search_documents",
  "mcp_den_query_librarian",
  "mcp_den_list_review_findings",
  "mcp_den_list_review_rounds",
  "mcp_den_get_worker_run_status",
  "den_channels_read_recent",
  "get_task",
  "get_thread",
  "get_messages",
  "get_latest_task_packet",
  "get_latest_worker_completion",
  "get_task_workflow_summary",
  "get_document",
  "search_documents",
  "query_librarian",
  "list_review_findings",
  "list_review_rounds",
  "get_worker_run_status",
];

export const delegatedChildLocalToolNames = localCodeToolNames;
