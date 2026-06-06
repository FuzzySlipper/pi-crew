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

export async function connectAll(
  registry: ChannelRegistry,
  logger: Logger,
): Promise<void> {
  for (const name of registry.list()) {
    const provider = registry.get(name);
    if (provider) {
      logger.info("Connecting channel provider", { name });
      await provider.connect();
    }
  }
}

// ── Den Channels adapter ────────────────────────────────────────

export { DenChannelsAdapter } from "./den-channels/den-channels-adapter.js";
export type { DenChannelsAdapterConfig } from "./den-channels/den-channels-adapter.js";

export {
  DenWebSocketConnection,
  SimulatedDenConnection,
} from "./den-channels/connection.js";
export type {
  DenConnection,
  DenConnectionConfig,
  DenConnectionEvents,
  DenInboundMessage,
  DenOutboundPayload,
  DenSender,
  DenContent,
  DenBreadcrumbPayload,
  DenSendResult,
} from "./den-channels/connection.js";

export {
  translateInboundMessage,
  translateDenSender,
  translateDenContent,
  translateOutboundContent,
  channelContentToDenContent,
  translateBreadcrumbToDen,
} from "./den-channels/message-format.js";
