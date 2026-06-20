/**
 * Infra assembly builder — bootstrap bootstrap config, logger, event bus,
 * hook registry, service registry, and the Gateway instance.
 *
 * First in the dependency chain: all other assemblies depend on these.
 *
 * @module pi-crew/infra-assembly
 */

import type { Logger, EventBus } from "@pi-crew/core";
import { FakeEventBus, FakeLogger, InMemoryHookRegistry } from "@pi-crew/core";
import { InMemoryToolPolicySessionRegistry } from "@pi-crew/service";
import { loadConfig, Gateway, createServiceRegistry, type ServiceRegistry, type GatewayConfig } from "@pi-crew/service";
import type { CrewConfig } from "./config.js";

export interface InfraAssembly {
  readonly config: CrewConfig;
  readonly gatewayConfig: GatewayConfig;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly registry: ServiceRegistry;
  readonly gateway: Gateway;
  readonly toolPolicySessionRegistry: InMemoryToolPolicySessionRegistry;
}

export function setupInfra(
  config: CrewConfig,
  logger?: Logger,
  eventBus?: EventBus,
): InfraAssembly {
  const resolvedLogger = logger ?? new FakeLogger();
  const resolvedEventBus = eventBus ?? new FakeEventBus();
  const hookRegistry = new InMemoryHookRegistry(resolvedLogger);
  const toolPolicySessionRegistry = new InMemoryToolPolicySessionRegistry();

  const gatewayConfig = loadConfig({
    admin: config.admin,
    database: config.database,
    den: config.den,
    health: config.health,
    logging: config.logging,
    runtime: config.runtime,
  });

  const registry = createServiceRegistry({
    config: gatewayConfig,
    logger: resolvedLogger,
    eventBus: resolvedEventBus,
    hookRegistry,
    toolPolicySessionRegistry,
  });

  const gateway = new Gateway(
    registry.config,
    registry.logger,
    registry.eventBus,
  );

  return {
    config,
    gatewayConfig,
    logger: resolvedLogger,
    eventBus: resolvedEventBus,
    registry,
    gateway,
    toolPolicySessionRegistry,
  };
}
