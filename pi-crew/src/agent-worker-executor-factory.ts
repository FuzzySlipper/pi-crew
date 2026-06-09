/** Crew-level factory for production LLM-backed worker executors. */

import type { Logger } from "@pi-crew/core";
import { loadProfile } from "@pi-crew/profiles";
import type { MCPClient, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import type { ToolCallContentBlock } from "@pi-crew/mcp";
import {
  AgentWorkerExecutor,
  type DelegatedSpawnLifecycle,
  type AgentWorkerToolProvider,
  type AgentWorkerToolProviderInput,
  type WorkerModelConfig,
  type WorkerModelConfigSource,
} from "@pi-crew/service";
import type { AgentTool, AgentToolResult } from "@pi-crew/service";

export interface CrewAgentWorkerExecutorDeps {
  readonly mcpClient: MCPClient;
  readonly toolRegistry: McpToolRegistry;
  readonly logger: Logger;
  readonly delegatedSpawnLifecycle?: DelegatedSpawnLifecycle;
}

class FilesystemWorkerModelConfigSource implements WorkerModelConfigSource {
  constructor(private readonly logger: Logger) {}

  getProfileModelConfig(profileId: string): WorkerModelConfig | undefined {
    try {
      const profile = loadProfile(profileId);
      const config = profile.modelConfig;
      if (config === undefined) return undefined;
      return {
        provider: config.provider,
        modelName: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      };
    } catch (error: unknown) {
      this.logger.warn("Worker profile model config unavailable", {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

export function createCrewAgentWorkerExecutor(
  deps: CrewAgentWorkerExecutorDeps,
): AgentWorkerExecutor {
  return new AgentWorkerExecutor({
    modelConfigSource: new FilesystemWorkerModelConfigSource(deps.logger),
    toolProvider: createCrewAgentWorkerToolProvider(deps),
    delegatedSpawnLifecycle: deps.delegatedSpawnLifecycle,
  });
}

export function createCrewAgentWorkerToolProvider(
  deps: CrewAgentWorkerExecutorDeps,
): AgentWorkerToolProvider {
  return ({ roleInput, toolSets }) => [
    createCompletionMarkerTool(roleInput),
    createContextStatusTool(roleInput),
    ...deps.toolRegistry
      .listTools()
      .filter((tool) => toolMatchesSelectedSet(tool.name, toolSets))
      .map((tool) => ({
        label: tool.name,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult> => {
          const result = await deps.mcpClient.callTool(tool.name, paramsToRecord(params));
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
      } satisfies AgentTool)),
  ];
}

function createCompletionMarkerTool(
  roleInput: AgentWorkerToolProviderInput["roleInput"],
): AgentTool {
  return {
    label: "Post structured completion",
    name: "post_structured_completion",
    description:
      "Mark this Den worker assignment as ready for WorkerRuntime to post its structured completion packet.",
    parameters: { type: "object", additionalProperties: true },
    execute: () => Promise.resolve({
      content: [
        {
          type: "text",
          text:
            `Structured completion accepted for run ${roleInput.binding.runId}; ` +
            "WorkerRuntime will post the canonical Den packet.",
        },
      ],
      details: { ok: true, runId: roleInput.binding.runId },
      terminate: true,
    }),
  };
}

function createContextStatusTool(
  roleInput: AgentWorkerToolProviderInput["roleInput"],
): AgentTool {
  return {
    label: "Context status",
    name: "context_status",
    description: "Report this worker assignment binding and prompt-packet context.",
    parameters: { type: "object", additionalProperties: true },
    execute: () => Promise.resolve({
      content: [
        {
          type: "text",
          text:
            `role=${roleInput.binding.role} task=${roleInput.binding.taskId} ` +
            `run=${roleInput.binding.runId} target=${roleInput.targetPacketRef?.runId ?? "none"}`,
        },
      ],
      details: {
        role: roleInput.binding.role,
        binding: roleInput.binding,
        targetPacketRef: roleInput.targetPacketRef,
      },
    }),
  };
}

function toolMatchesSelectedSet(
  toolName: string,
  toolSets: readonly string[],
): boolean {
  const normalized = toolName.toLowerCase();
  return toolSets.some((toolSet) => matchesToolSet(normalized, toolSet));
}

function matchesToolSet(toolName: string, toolSet: string): boolean {
  const normalizedToolSet = toolSet.toLowerCase();
  switch (normalizedToolSet) {
    case "all":
      return false;
    case "den":
      return SAFE_DEN_TOOL_NAMES.has(stripMcpPrefix(toolName));
    case "filesystem":
      return toolName.includes("file") || toolName.includes("filesystem");
    case "filesystem_readonly":
      return toolName.includes("read_file") || toolName.includes("get_file") || toolName.includes("list_file");
    case "terminal":
      return toolName.includes("terminal") || toolName.includes("shell") || toolName.includes("process");
    case "git":
    case "git_diff_log":
      return toolName.includes("git");
    default:
      return toolName === normalizedToolSet || toolName.startsWith(`${normalizedToolSet}_`);
  }
}

const SAFE_DEN_TOOL_NAMES = new Set([
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
]);

function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith("mcp_den_")) return toolName.slice("mcp_den_".length);
  if (toolName.startsWith("den_")) return toolName.slice("den_".length);
  return toolName;
}

function paramsToRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null
    ? params as Record<string, unknown>
    : {};
}

function contentBlockToText(block: ToolCallContentBlock): { readonly type: "text"; readonly text: string } {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "resource") {
    return {
      type: "text",
      text: block.resource.text ?? block.resource.uri,
    };
  }
  return { type: "text", text: `[image:${block.mimeType}]` };
}
