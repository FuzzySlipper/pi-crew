/**
 * ChannelRegistry — central registry for all channel providers.
 *
 * Formalizes provider lifecycle (connectAll / disconnectAll) and provides
 * a single registration point for the crew composition root.
 *
 * After assembly decomposition (#2706), the DenChannelAssembly holds the
 * actual provider instances.  The registry wraps them with a unified
 * lifecycle and registration API.
 *
 * @module pi-crew/channel-registry
 */

import type { Logger, ChannelProvider } from "@pi-crew/core";

export interface ChannelRegistryOptions {
  /** Primary Den Channels provider. */
  readonly channelProvider: ChannelProvider;
  /** Per-agent Den Channels providers, keyed by member identity. */
  readonly perAgentProviders: ReadonlyMap<string, ChannelProvider>;
  /** Additional providers (Telegram, etc.). */
  readonly additionalProviders: ChannelProvider[];
}

export class ChannelRegistry {
  readonly #channelProvider: ChannelProvider;
  readonly #perAgentProviders: ReadonlyMap<string, ChannelProvider>;
  readonly #additionalProviders: ChannelProvider[];

  constructor(options: ChannelRegistryOptions) {
    this.#channelProvider = options.channelProvider;
    this.#perAgentProviders = options.perAgentProviders;
    this.#additionalProviders = [...options.additionalProviders];
  }

  /** All providers managed by this registry (primary first, then additional, then per-agent). */
  get allProviders(): ChannelProvider[] {
    return [
      this.#channelProvider,
      ...this.#additionalProviders,
      ...this.#perAgentProviders.values(),
    ];
  }

  /** Connect all providers. Failures are logged but non-fatal. */
  async connectAll(logger: Logger): Promise<void> {
    const all = this.allProviders;
    for (const provider of all) {
      try {
        await provider.connect();
      } catch (error: unknown) {
        logger.error("Provider connection failed", {
          provider: (provider as { name?: string }).name ?? "unknown",
          error: String(error),
        });
      }
    }
  }

  /** Disconnect all providers in reverse order. */
  async disconnectAll(): Promise<void> {
    const all = this.allProviders;
    for (const provider of all.reverse()) {
      await provider.disconnect();
    }
    all.reverse(); // restore original order (not strictly needed but defensive)
  }

  /** Register an additional provider after construction. */
  registerProvider(provider: ChannelProvider): void {
    this.#additionalProviders.push(provider);
  }

  /** The primary Den Channels provider. */
  get channelProvider(): ChannelProvider {
    return this.#channelProvider;
  }

  /** Per-agent providers, keyed by member identity. */
  get perAgentProviders(): ReadonlyMap<string, ChannelProvider> {
    return this.#perAgentProviders;
  }

  /** Additional providers registered explicitly. */
  get additionalProviders(): readonly ChannelProvider[] {
    return this.#additionalProviders;
  }
}
