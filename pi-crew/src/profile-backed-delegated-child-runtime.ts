import { loadProfile, assembleSystemPrompt, type ToolPolicy } from "@pi-crew/profiles";
import {
  resolveDelegatedChildModel,
  type DelegatedChildRuntimeResolution,
  type DelegatedChildRuntimeResolutionInput,
  type DelegatedChildRuntimeResolver,
  type ToolProvider,
} from "@pi-crew/service";
import type { ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";
import { delegatedChildLocalToolNames } from "./delegated-child-tool-provider.js";

export interface ProfileBackedDelegatedChildRuntimeDeps {
  readonly profilesRoot: string;
  readonly toolRegistry: McpToolRegistry;
  readonly toolProvider: ToolProvider;
  readonly fallbackBaseUrl?: string;
  readonly fallbackApiKey?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function createProfileBackedDelegatedChildRuntimeResolver(
  deps: ProfileBackedDelegatedChildRuntimeDeps,
): DelegatedChildRuntimeResolver {
  return new ProfileBackedDelegatedChildRuntimeResolver(deps);
}

class ProfileBackedDelegatedChildRuntimeResolver implements DelegatedChildRuntimeResolver {
  constructor(private readonly deps: ProfileBackedDelegatedChildRuntimeDeps) {}

  resolve(input: DelegatedChildRuntimeResolutionInput): Promise<DelegatedChildRuntimeResolution> {
    const profile = loadProfile(input.effectiveRuntime.profileId, this.deps.profilesRoot);
    const modelConfig = profile.modelConfig;
    const model = resolveDelegatedChildModel(
      {
        profileId: profile.id,
        provider:
          input.spawnRequest.modelSelection?.provider ??
          modelConfig?.provider ??
          input.effectiveRuntime.provider,
        model:
          input.spawnRequest.modelSelection?.model ??
          modelConfig?.model ??
          input.effectiveRuntime.model,
      },
      {
        baseUrl: modelConfig?.baseUrl ?? this.deps.fallbackBaseUrl,
      },
    );
    const allowedToolNames = [
      ...new Set(
        selectProfileToolNames(profile.toolPolicy, [
          ...this.deps.toolRegistry.listTools().map((tool) => tool.name),
          ...delegatedChildLocalToolNames,
        ]),
      ),
    ];
    const tools = this.deps.toolProvider.resolveTools(allowedToolNames);
    return Promise.resolve({
      systemPrompt: assembleSystemPrompt({
        profile,
        runtime: {
          role: "delegated",
          extra: {
            parentPolicyId: input.policy.policyId,
            requestedTask: input.spawnRequest.task.slice(0, 240),
          },
        },
      }),
      model,
      effectiveRuntime: {
        profileId: profile.id,
        provider: model.provider,
        model: model.id,
      },
      runtimeConfig: profile.runtimeConfig,
      tools,
      apiKey:
        resolveApiKey(modelConfig?.apiKeyEnv, this.deps.env ?? process.env) ??
        this.deps.fallbackApiKey,
    });
  }
}

function selectProfileToolNames(
  policy: ToolPolicy | undefined,
  registryToolNames: readonly string[],
): string[] {
  const mode = policy?.mode ?? "allow_all";
  if (mode === "allow_all") return [...registryToolNames];
  if (mode === "allow_list") {
    const allowed = policy?.allow ?? [];
    return registryToolNames.filter((toolName) =>
      allowed.some((entry) => toolMatchesSelectedSet(toolName, entry)),
    );
  }
  const denied = policy?.deny ?? [];
  return registryToolNames.filter(
    (toolName) => !denied.some((entry) => toolMatchesSelectedSet(toolName, entry)),
  );
}

function toolMatchesSelectedSet(toolName: string, toolSet: string): boolean {
  const normalized = toolName.toLowerCase();
  const normalizedSet = toolSet.toLowerCase();
  switch (normalizedSet) {
    case "all":
      return true;
    case "den":
      return SAFE_DEN_TOOL_NAMES.has(stripMcpPrefix(normalized));
    case "filesystem":
      return ["read_file", "write_file", "search_files"].includes(normalized);
    case "filesystem_readonly":
      return ["read_file", "search_files"].includes(normalized);
    case "terminal":
      return normalized === "terminal";
    case "git":
    case "git_diff_log":
      return normalized.startsWith("git_") || normalized === "git";
    default:
      return normalized === normalizedSet || normalized.startsWith(`${normalizedSet}_`);
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
  "den_channels_read_recent",
]);

function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith("mcp_den_")) return toolName.slice("mcp_den_".length);
  if (toolName.startsWith("den_")) return toolName.slice("den_".length);
  return toolName;
}

function resolveApiKey(
  apiKeyEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (apiKeyEnv === undefined || apiKeyEnv.trim() === "") return undefined;
  const value = env[apiKeyEnv];
  return value === undefined || value.trim() === "" ? undefined : value;
}
