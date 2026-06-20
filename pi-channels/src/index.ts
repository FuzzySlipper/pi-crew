// pi-channels — Platform adapters implementing ChannelProvider.
// Depends on: pi-core

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
