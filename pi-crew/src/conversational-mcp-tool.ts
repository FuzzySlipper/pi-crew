import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
  MCPClient,
  ToolCallContentBlock,
  ToolRegistry as McpToolRegistry,
} from "@pi-crew/mcp";

export interface DefaultDenToolContext {
  readonly sender: string;
  readonly projectId?: string;
}

export function createConversationalMcpAgentTool(
  tool: ReturnType<McpToolRegistry["listTools"]>[number],
  mcpClient: MCPClient,
  defaults: DefaultDenToolContext,
): AgentTool {
  return {
    label: tool.name,
    name: tool.name,
    description: tool.description,
    parameters: schemaWithDefaultedDenArgsOptional(tool.name, tool.inputSchema),
    execute: async (_toolCallId, params) => {
      const normalized = withDefaultDenArgs(tool.name, paramsToRecord(params), defaults);
      const result = await mcpClient.callTool(tool.name, normalized);
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
  };
}

function schemaWithDefaultedDenArgsOptional(
  toolName: string,
  schema: AgentTool["parameters"],
): AgentTool["parameters"] {
  if (!isDenWriteTool(toolName) || !isRecord(schema)) return schema;
  const required = schema["required"];
  if (!Array.isArray(required)) return schema;
  return {
    ...schema,
    required: required.filter((field) => field !== "sender" && field !== "project_id"),
  } as AgentTool["parameters"];
}

function withDefaultDenArgs(
  toolName: string,
  params: Record<string, unknown>,
  defaults: DefaultDenToolContext,
): Record<string, unknown> {
  const normalized = { ...params };
  if (!isDenWriteTool(toolName)) return normalized;
  if (normalized["sender"] === undefined) normalized["sender"] = defaults.sender;
  if (normalized["project_id"] === undefined && defaults.projectId !== undefined) {
    normalized["project_id"] = defaults.projectId;
  }
  return normalized;
}

function isDenWriteTool(toolName: string): boolean {
  const normalized = stripMcpPrefix(toolName.toLowerCase());
  return (
    normalized === "send_message" ||
    normalized === "post_review_findings" ||
    normalized === "create_review_finding" ||
    normalized === "request_review" ||
    normalized === "set_review_verdict" ||
    normalized === "update_task"
  );
}

function paramsToRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function contentBlockToText(block: ToolCallContentBlock): TextContent {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "resource") {
    return { type: "text", text: block.resource.text ?? block.resource.uri };
  }
  return { type: "text", text: `[image:${block.mimeType}]` };
}

function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith("mcp_den_")) return toolName.slice("mcp_den_".length);
  if (toolName.startsWith("den_")) return toolName.slice("den_".length);
  return toolName;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
