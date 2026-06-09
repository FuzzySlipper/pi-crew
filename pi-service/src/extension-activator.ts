/**
 * Service-owned extension activation and context bridge.
 *
 * pi-core owns foundation Extension/HookRegistry contracts only. This module
 * keeps pi-service runtime/session capabilities behind narrow service-local
 * ports so concrete service extensions do not leak SessionManager or runtime
 * internals into lower packages.
 *
 * @module pi-service/extension-activator
 */

import type {
  DelegationConstraints,
  EffectiveDelegationRuntime,
  EventBus,
  ExecutionPolicy,
  ExtensionContext,
  HookRegistry,
  Logger,
} from "@pi-crew/core";
import type { GatewayConfig } from "./config.js";
import type { SessionKind, SessionState } from "./sessions/types.js";

/** Session projection exposed to service extensions. */
export interface ServiceSessionView {
  /** Stable session id. */
  readonly sessionId: string;
  /** Profile bound to the session. */
  readonly profileId: string;
  /** Conversational or worker session. */
  readonly kind: SessionKind;
  /** Service lifecycle state. */
  readonly state: SessionState;
  /** Parent session id for delegated sessions. */
  readonly parentSessionId: string | null;
  /** Root session id for delegated lineages. */
  readonly rootSessionId: string;
}

/** Request used by a service extension to create a delegated child session. */
export interface DelegatedSessionCreateRequest {
  /** Deterministic child session id allocated before policy derivation. */
  readonly sessionId?: string;
  /** Existing parent session that owns the child. */
  readonly parentSessionId: string;
  /** Profile used by the child session. */
  readonly profileId: string;
  /** Child execution policy derived from the parent policy. */
  readonly policy: ExecutionPolicy;
  /** Child runtime selected by the lifecycle after fail-closed validation. */
  readonly effectiveRuntime?: EffectiveDelegationRuntime;
  /** Child's remaining delegation budget for descendants. */
  readonly delegationConstraints?: DelegationConstraints;
  /** Optional Den/runtime visibility metadata emitted with the spawn. */
  readonly visibility?: Readonly<Record<string, unknown>>;
}

/** Runtime-local visibility event emitted by service extensions. */
export interface DelegationVisibilityEvent {
  /** Session the event is about. */
  readonly sessionId: string;
  /** Stable typed event name. */
  readonly eventType: string;
  /** Optional low-cardinality metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Narrow service-owned port for delegated session lifecycle.
 *
 * DESIGN: This is intentionally not SessionManager. Rationale: #2169 should
 * consume this service-owned bridge so delegated lifecycle extensions can be
 * implemented without exporting or importing concrete runtime internals.
 */
export interface DelegationSessionBridge {
  /** Look up any active/non-archived session by id. */
  getSession(sessionId: string): Promise<ServiceSessionView | null>;
  /** Create a delegated child session. */
  createDelegatedSession(request: DelegatedSessionCreateRequest): Promise<ServiceSessionView>;
  /** List active child sessions for a parent. */
  listChildSessions(parentSessionId: string): Promise<readonly ServiceSessionView[]>;
  /** Count active child sessions for concurrency gates. */
  countChildSessions(parentSessionId: string): Promise<number>;
  /** Look up the effective parent execution policy for a child. */
  getParentExecutionPolicy(childSessionId: string): Promise<ExecutionPolicy | null>;
  /** Release a child after normal completion. */
  releaseChildSession(childSessionId: string, reason: string): Promise<void>;
  /** Kill a child after timeout/abort. */
  killChildSession(childSessionId: string, reason: string): Promise<void>;
  /** Archive a child after cleanup. */
  archiveChildSession(childSessionId: string, reason: string): Promise<void>;
  /** Emit visibility for delegated lifecycle events. */
  emitVisibilityEvent(event: DelegationVisibilityEvent): Promise<void>;
}

/** Service-local extension context with validated config and runtime bridges. */
export interface ServiceExtensionContext extends ExtensionContext {
  /** Validated runtime configuration snapshot. */
  readonly config: GatewayConfig;
  /** Narrow delegated session lifecycle bridge. */
  readonly delegationSessions: DelegationSessionBridge;
}

/** Concrete service extension activated by pi-service composition root. */
export interface ServiceExtension {
  /** Stable service-local extension id. */
  readonly id: string;
  /** Optional diagnostics description. */
  readonly description?: string;
  /** Register hooks/subscriptions/resources. */
  activate(context: ServiceExtensionContext): Promise<void>;
  /** Unregister hooks/subscriptions/resources. */
  deactivate(): Promise<void>;
}

/** Options for service extension activation. */
export interface ExtensionActivatorOptions {
  /** Deterministic composition-root extension order. */
  readonly extensions: readonly ServiceExtension[];
  /** Shared service extension context. */
  readonly context: ServiceExtensionContext;
}

/** Options for creating a service extension context. */
export interface CreateServiceExtensionContextOptions {
  readonly config: GatewayConfig;
  readonly hookRegistry: HookRegistry;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly delegationSessions: DelegationSessionBridge;
}

/** Error thrown when an extension activation fails. */
export class ExtensionActivationError extends Error {
  readonly code = "EXTENSION_ACTIVATION_ERROR";
  readonly extensionId: string;

  constructor(extensionId: string, cause: unknown) {
    super(`Extension activation failed: ${extensionId}`, { cause });
    this.name = "ExtensionActivationError";
    this.extensionId = extensionId;
  }
}

/** Error thrown when an extension deactivation fails. */
export class ExtensionDeactivationError extends Error {
  readonly code = "EXTENSION_DEACTIVATION_ERROR";
  readonly extensionId: string;

  constructor(extensionId: string, cause: unknown) {
    super(`Extension deactivation failed: ${extensionId}`, { cause });
    this.name = "ExtensionDeactivationError";
    this.extensionId = extensionId;
  }
}

/** Error thrown by the fail-closed unavailable delegation bridge. */
export class DelegationBridgeUnavailableError extends Error {
  readonly code = "DELEGATION_BRIDGE_UNAVAILABLE";

  constructor(operation: string) {
    super(`Delegation session bridge unavailable for ${operation}`);
    this.name = "DelegationBridgeUnavailableError";
  }
}

/** Build the service-local extension context from explicitly injected services. */
export function createServiceExtensionContext(
  options: CreateServiceExtensionContextOptions,
): ServiceExtensionContext {
  return {
    config: options.config,
    hookRegistry: options.hookRegistry,
    eventBus: options.eventBus,
    logger: options.logger,
    delegationSessions: options.delegationSessions,
  };
}

/** Create a fail-closed placeholder for tests/composition roots without delegation wiring. */
export function createUnavailableDelegationSessionBridge(): DelegationSessionBridge {
  return {
    getSession() {
      return Promise.resolve(null);
    },
    createDelegatedSession() {
      return Promise.reject(new DelegationBridgeUnavailableError("createDelegatedSession"));
    },
    listChildSessions() {
      return Promise.resolve([]);
    },
    countChildSessions() {
      return Promise.resolve(0);
    },
    getParentExecutionPolicy() {
      return Promise.resolve(null);
    },
    releaseChildSession() {
      return Promise.reject(new DelegationBridgeUnavailableError("releaseChildSession"));
    },
    killChildSession() {
      return Promise.reject(new DelegationBridgeUnavailableError("killChildSession"));
    },
    archiveChildSession() {
      return Promise.reject(new DelegationBridgeUnavailableError("archiveChildSession"));
    },
    emitVisibilityEvent() {
      return Promise.reject(new DelegationBridgeUnavailableError("emitVisibilityEvent"));
    },
  };
}

/** Ordered service extension lifecycle manager. */
export class ExtensionActivator {
  readonly #extensions: readonly ServiceExtension[];
  readonly #context: ServiceExtensionContext;
  readonly #activated: ServiceExtension[] = [];

  constructor(options: ExtensionActivatorOptions) {
    this.#extensions = options.extensions;
    this.#context = options.context;
  }

  /** Activate all configured extensions in composition-root order. */
  async activateAll(): Promise<void> {
    for (const extension of this.#extensions) {
      try {
        this.#context.logger.info("extension.activating", { extensionId: extension.id });
        await extension.activate(this.#context);
        this.#activated.push(extension);
        this.#context.logger.info("extension.activated", { extensionId: extension.id });
      } catch (cause) {
        await this.deactivateActivatedAfterFailure();
        throw new ExtensionActivationError(extension.id, cause);
      }
    }
  }

  /** Deactivate activated extensions in reverse activation order. */
  async deactivateAll(): Promise<void> {
    while (this.#activated.length > 0) {
      const extension = this.#activated.pop();
      if (extension === undefined) return;
      await this.deactivateOne(extension);
    }
  }

  private async deactivateActivatedAfterFailure(): Promise<void> {
    while (this.#activated.length > 0) {
      const extension = this.#activated.pop();
      if (extension === undefined) return;
      try {
        await this.deactivateOne(extension);
      } catch (cause) {
        this.#context.logger.error("extension.deactivation_after_failure_failed", {
          extensionId: extension.id,
          cause,
        });
      }
    }
  }

  private async deactivateOne(extension: ServiceExtension): Promise<void> {
    try {
      this.#context.logger.info("extension.deactivating", { extensionId: extension.id });
      await extension.deactivate();
      this.#context.logger.info("extension.deactivated", { extensionId: extension.id });
    } catch (cause) {
      throw new ExtensionDeactivationError(extension.id, cause);
    }
  }
}
