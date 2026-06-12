import { ConfigurationError } from "@pi-crew/core";
import {
  LlmDelegatedChildRunner,
  SessionMaterializedDelegatedChildRunner,
  type DelegatedChildRunner,
  type DelegatedSpawnLifecycle,
  type DelegatedSpawnLifecyclePort,
} from "@pi-crew/service";
import type { CrewConfig } from "./config.js";
import { createDelegatedChildToolProvider, type DelegatedChildToolProviderDeps } from "./delegated-child-tool-provider.js";

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
  deps?: DelegatedChildToolProviderDeps,
): DelegatedChildRunner {
  if (config.llmBaseUrl === undefined) return new SessionMaterializedDelegatedChildRunner();
  return new LlmDelegatedChildRunner({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    modelName: config.llmModelName,
    ...(deps === undefined ? {} : { toolProvider: createDelegatedChildToolProvider(deps) }),
  });
}
