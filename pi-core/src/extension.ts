/**
 * Extension activation primitives for pi-crew modules.
 *
 * These foundation types stay in pi-core and intentionally avoid service
 * configuration, concrete runtime, or adapter implementation details.
 *
 * @module pi-core/extension
 */

import type { EventBus } from "./events.js";
import type { HookRegistry } from "./hooks.js";
import type { Logger } from "./logging.js";

/** Context exposed to extensions during activation. */
export interface ExtensionContext {
  /** Hook registry for registering interception handlers. */
  readonly hookRegistry: HookRegistry;
  /** Event bus for notification subscriptions and emissions. */
  readonly eventBus: EventBus;
  /** Structured logger for extension diagnostics. */
  readonly logger: Logger;
}

/** Module that registers hooks and/or event subscriptions. */
export interface Extension {
  /** Stable identifier, e.g. "pi-tools" or "pi-governance". */
  readonly id: string;
  /** Human-readable description for diagnostics. */
  readonly description?: string;

  /** Activate the extension and register all handlers/subscriptions. */
  activate(context: ExtensionContext): Promise<void>;

  /** Deactivate the extension and release registrations/subscriptions. */
  deactivate(): Promise<void>;
}

/** Declares config keys an extension cares about without importing config types. */
export interface ExtensionConfigInterest {
  readonly extensionId: string;
  readonly configKeys: ReadonlySet<string>;
}
