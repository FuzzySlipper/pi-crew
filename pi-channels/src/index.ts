// pi-channels — Platform adapters implementing ChannelProvider.
// Depends on: pi-core

import type { ChannelProvider, Logger } from "@pi-crew/core";

export class ChannelRegistry {
  private readonly providers = new Map<string, ChannelProvider>();

  register(provider: ChannelProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): ChannelProvider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}

export async function startAll(
  registry: ChannelRegistry,
  logger: Logger,
): Promise<void> {
  for (const name of registry.list()) {
    const provider = registry.get(name);
    if (provider) {
      logger.info("Starting channel provider", { name });
      await provider.start();
    }
  }
}
