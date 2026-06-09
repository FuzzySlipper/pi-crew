/**
 * Dependency-injection container for the pi-service gateway.
 *
 * Every dependency is passed through constructors.  There are **no
 * global singletons** — the container is the only place that knows
 * about concrete implementations, and it is created once in main.ts.
 *
 * Modules (gateway, session manager, etc.) receive their dependencies
 * explicitly and never import from each other.
 *
 * @module pi-service/di
 */

import type { Logger, EventBus, HookRegistry } from "@pi-crew/core";
import type { GatewayConfig } from "./config.js";

// ── Service registry ────────────────────────────────────────────

/**
 * A service registry holding every component the gateway composes.
 *
 * Each service is either eagerly created or provided lazily, but the
 * container enforces that every dependency is constructor-injected
 * rather than resolved through a global singleton.
 */
export interface ServiceRegistry {
  /** Validated gateway configuration (immutable after startup). */
  readonly config: GatewayConfig;

  /** Structured logger. */
  readonly logger: Logger;

  /** Typed event bus for decoupled module communication. */
  readonly eventBus: EventBus;

  /** Typed hook registry for service extension interception. */
  readonly hookRegistry: HookRegistry;
}

// ── Factory ─────────────────────────────────────────────────────

/**
 * Options for {@link createServiceRegistry}.
 */
export interface CreateRegistryOptions {
  /** Validated gateway configuration. */
  config: GatewayConfig;
  /** Structured logger implementation. */
  logger: Logger;
  /** Type-safe event bus implementation. */
  eventBus: EventBus;
  /** Type-safe hook registry implementation. */
  hookRegistry: HookRegistry;
}

/**
 * Assemble the service registry.
 *
 * Every dependency is explicitly provided — nothing is resolved
 * implicitly.  The returned registry can be passed to any module
 * that needs typed access to gateway services.
 */
export function createServiceRegistry(
  options: CreateRegistryOptions,
): ServiceRegistry {
  return {
    config: options.config,
    logger: options.logger,
    eventBus: options.eventBus,
    hookRegistry: options.hookRegistry,
  };
}
