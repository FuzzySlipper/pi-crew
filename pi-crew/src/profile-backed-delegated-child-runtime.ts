import { loadProfile, assembleSystemPrompt, type ToolPolicy } from "@pi-crew/profiles";
import {
  resolveDelegatedChildModel,
  type DelegatedChildRuntimeResolution,
  type DelegatedChildRuntimeResolutionInput,
  type DelegatedChildRuntimeResolver,
  type ToolProvider,
} from "@pi-crew/service";
import type { ToolRegistry as McpToolRegistry } from "@pi-crew/mcp";

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
    const allowedToolNames = selectProfileToolNames(
      profile.toolPolicy,
      this.deps.toolRegistry.listTools().map((tool) => tool.name),
    );
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
  if (normalizedSet === "all") return true;
  return normalized === normalizedSet || normalized.startsWith(`${normalizedSet}_`);
}

function resolveApiKey(
  apiKeyEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (apiKeyEnv === undefined || apiKeyEnv.trim() === "") return undefined;
  const value = env[apiKeyEnv];
  return value === undefined || value.trim() === "" ? undefined : value;
}
