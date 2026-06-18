/** Crew-level factory for production LLM-backed worker executors. */

import type { EventBus, Logger } from "@pi-crew/core";
import type { DenMemoryPolicyMode } from "@pi-crew/memory";
import { loadProfile } from "@pi-crew/profiles";
import type { ToolPolicy } from "@pi-crew/profiles";
import type { MCPClient, ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import type { ToolCallContentBlock } from "@pi-crew/mcp";
import {
  AgentWorkerExecutor,
  type DelegatedSpawnLifecycle,
  type AgentWorkerToolProvider,
  type AgentWorkerToolProviderInput,
  type WorkerModelConfig,
  type WorkerModelConfigSource,
  type StreamRetryConfig,
} from "@pi-crew/service";
import { createDenMemoryTools } from "./den-memory-tools.js";
import type { AgentTool, AgentToolResult } from "@pi-crew/service";

export interface CrewAgentWorkerExecutorDeps {
  readonly mcpClient: MCPClient;
  readonly toolRegistry: McpToolRegistry;
  readonly logger: Logger;
  readonly profilesRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly delegatedSpawnLifecycle?: DelegatedSpawnLifecycle;
  readonly streamRetry?: StreamRetryConfig;
  readonly eventBus?: EventBus;
  readonly memory?: {
    readonly enabled: boolean;
    readonly baseUrl?: string;
    readonly requestTimeoutMs: number;
    readonly workerPolicy: DenMemoryPolicyMode;
  };
}

export interface CrewWorkerModelConfigSourceDeps {
  readonly logger: Logger;
  readonly profilesRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

class FilesystemWorkerModelConfigSource implements WorkerModelConfigSource {
  constructor(
    private readonly logger: Logger,
    private readonly profilesRoot?: string,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  getProfileModelConfig(profileId: string): WorkerModelConfig | undefined {
    try {
      const profile = loadProfile(profileId, this.profilesRoot);
      const config = profile.modelConfig;
      if (config === undefined) return undefined;
      return {
        provider: config.provider,
        modelName: config.model,
        modelBaseUrl: config.baseUrl,
        modelApi: config.api,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        apiKey: resolveApiKey(config.apiKeyEnv, this.env),
      };
    } catch (error: unknown) {
      this.logger.warn("Worker profile model config unavailable", {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  getProfileToolPolicy(profileId: string): ToolPolicy | undefined {
    try {
      return loadProfile(profileId, this.profilesRoot).toolPolicy;
    } catch (error: unknown) {
      this.logger.warn("Worker profile tool policy unavailable", {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

export function createCrewWorkerModelConfigSource(
  deps: CrewWorkerModelConfigSourceDeps,
): WorkerModelConfigSource {
  return new FilesystemWorkerModelConfigSource(deps.logger, deps.profilesRoot, deps.env);
}

export function createCrewAgentWorkerExecutor(
  deps: CrewAgentWorkerExecutorDeps,
): AgentWorkerExecutor {
  return new AgentWorkerExecutor({
    modelConfigSource: createCrewWorkerModelConfigSource(deps),
    toolProvider: createCrewAgentWorkerToolProvider(deps),
    delegatedSpawnLifecycle: deps.delegatedSpawnLifecycle,
    streamRetry: deps.streamRetry,
    eventBus: deps.eventBus,
  });
}

function resolveApiKey(
  apiKeyEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (apiKeyEnv === undefined || apiKeyEnv.trim() === "") return undefined;
  return env[apiKeyEnv];
}

export function createCrewAgentWorkerToolProvider(
  deps: CrewAgentWorkerExecutorDeps,
): AgentWorkerToolProvider {
  return ({ roleInput, toolSets }) => [
    createCompletionMarkerTool(roleInput),
    createContextStatusTool(roleInput),
    ...createWorkerMemoryTools(deps, roleInput, toolSets),
    ...deps.toolRegistry
      .listTools()
      .filter((tool) => toolMatchesSelectedSet(tool.name, toolSets))
      .map(
        (tool) =>
          ({
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
          }) satisfies AgentTool,
      ),
  ];
}

function createWorkerMemoryTools(
  deps: CrewAgentWorkerExecutorDeps,
  roleInput: AgentWorkerToolProviderInput["roleInput"],
  toolSets: readonly string[],
): AgentTool[] {
  if (deps.memory?.enabled !== true || deps.memory.baseUrl === undefined) return [];
  return createDenMemoryTools({
    baseUrl: deps.memory.baseUrl,
    requestTimeoutMs: deps.memory.requestTimeoutMs,
    policyMode: deps.memory.workerPolicy,
    context: {
      agentIdentity: roleInput.binding.role,
      profileId: roleInput.profileId,
      sessionId: roleInput.sessionId,
      sessionKind: "worker_assignment",
      projectId: roleInput.binding.projectId,
      taskId: roleInput.binding.taskId,
      assignmentId: roleInput.binding.assignmentId,
      runId: roleInput.binding.runId,
      role: roleInput.binding.role,
      mode: roleInput.binding.role === "reviewer" ? "review" : "implementation",
    },
  }).filter((tool) => toolMatchesSelectedSet(tool.name, toolSets));
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
    execute: () =>
      Promise.resolve({
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

function createContextStatusTool(roleInput: AgentWorkerToolProviderInput["roleInput"]): AgentTool {
  return {
    label: "Context status",
    name: "context_status",
    description: "Report this worker assignment binding and prompt-packet context.",
    parameters: { type: "object", additionalProperties: true },
    execute: () =>
      Promise.resolve({
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

function toolMatchesSelectedSet(toolName: string, toolSets: readonly string[]): boolean {
  const normalized = toolName.toLowerCase();
  return toolSets.some((toolSet) => matchesToolSet(normalized, toolSet));
}

function matchesToolSet(toolName: string, toolSet: string): boolean {
  const normalizedToolSet = toolSet.toLowerCase();
  switch (normalizedToolSet) {
    case "all":
      return false;
    case "den":
      return (
        toolName !== "all" &&
        !toolName.includes("file") &&
        !toolName.includes("filesystem") &&
        !toolName.includes("terminal") &&
        !toolName.includes("shell") &&
        !toolName.includes("process") &&
        !toolName.includes("git") &&
        !toolName.startsWith("den_memory_") &&
        !toolName.startsWith("browser_") &&
        !toolName.startsWith("web_")
      );
    case "filesystem":
      return toolName.includes("file") || toolName.includes("filesystem");
    case "filesystem_readonly":
      return (
        toolName.includes("read_file") ||
        toolName.includes("get_file") ||
        toolName.includes("list_file")
      );
    case "terminal":
      return (
        toolName.includes("terminal") || toolName.includes("shell") || toolName.includes("process")
      );
    case "git":
    case "git_diff_log":
      return toolName.includes("git");
    case "memory":
      return toolName.startsWith("den_memory_");
    default:
      return toolName === normalizedToolSet || toolName.startsWith(`${normalizedToolSet}_`);
  }
}

function paramsToRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

function contentBlockToText(block: ToolCallContentBlock): {
  readonly type: "text";
  readonly text: string;
} {
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
