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

// ── Telegram adapter ────────────────────────────────────────────

export { TelegramChannelProvider } from "./telegram/telegram-channel-provider.js";
export type { TelegramChannelProviderConfig } from "./telegram/telegram-channel-provider.js";

export { TelegramPollingConnection, resolveBotToken } from "./telegram/telegram-connection.js";

export type {
  TelegramConnection,
  TelegramConnectionEvents,
  TelegramProviderConfig,
  TelegramUpdate,
  TelegramMessage,
  TelegramUser,
  TelegramChat,
  TelegramCallbackQuery,
  TelegramPhotoSize,
  TelegramDocument,
  TelegramSendMessageParams,
  TelegramEditMessageTextParams,
  TelegramDeleteMessageParams,
  TelegramSendChatActionParams,
  TelegramGetFileParams,
  TelegramFile,
  TelegramApiResponse,
  TelegramGetUpdatesResponse,
} from "./telegram/telegram-types.js";

export {
  translateTelegramUpdate,
  translateTelegramMessage,
  translateTelegramSender,
  translateTelegramUser,
  translateTelegramContent,
  translateCallbackQuery,
  channelContentToTelegramText,
  buildSendMessageParams,
  breadcrumbToTelegramText,
  escapeMarkdownV2,
  telegramChatId,
} from "./telegram/telegram-message-format.js";
