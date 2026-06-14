import { ConfigurationError } from "@pi-crew/core";
import {
  LlmDelegatedChildRunner,
  type DelegatedChildRunner,
  type DelegatedSpawnLifecycle,
  type DelegatedSpawnLifecyclePort,
} from "@pi-crew/service";
import type { CrewConfig } from "./config.js";
import {
  createDelegatedChildToolProvider,
  type DelegatedChildToolProviderDeps,
} from "./delegated-child-tool-provider.js";
import { createProfileBackedDelegatedChildRuntimeResolver } from "./profile-backed-delegated-child-runtime.js";

export interface DeferredDelegationLifecyclePort {
  readonly port: DelegatedSpawnLifecyclePort;
  set(lifecycle: DelegatedSpawnLifecycle): void;
}

export function createDeferredDelegationLifecyclePort(): DeferredDelegationLifecyclePort {
  let delegate: DelegatedSpawnLifecycle | undefined;
  return {
    port: {
      spawn: (input) => {
        if (delegate === undefined) {
          throw new ConfigurationError("Delegation lifecycle is not assembled");
        }
        return delegate.spawn(input);
      },
    },
    set(lifecycle) {
      delegate = lifecycle;
    },
  };
}

export function createDelegatedChildRunner(
  config: CrewConfig["delegation"],
  deps?: DelegatedChildToolProviderDeps & { readonly profilesRoot?: string },
): DelegatedChildRunner {
  const toolProvider = deps === undefined ? undefined : createDelegatedChildToolProvider(deps);
  return new LlmDelegatedChildRunner({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    modelName: config.llmModelName,
    ...(toolProvider === undefined ? {} : { toolProvider }),
    ...(deps?.profilesRoot === undefined || toolProvider === undefined
      ? {}
      : {
          runtimeResolver: createProfileBackedDelegatedChildRuntimeResolver({
            profilesRoot: deps.profilesRoot,
            toolRegistry: deps.toolRegistry,
            toolProvider,
            fallbackBaseUrl: config.llmBaseUrl,
            fallbackApiKey: config.llmApiKey,
          }),
        }),
  });
}
