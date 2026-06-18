/**
 * Factory for creating {@link ChannelProvider} instances from config.
 *
 * Maps `providerId` → concrete provider constructor.  Currently supports:
 * - `"den-channels"` — {@link DenChannelsAdapter} (default, always present)
 * - `"telegram"` — {@link TelegramChannelProvider}
 *
 * DESIGN: Factory function, not a class.  Rationale: No state to encapsulate;
 * the factory is a pure mapping from config + dependencies → provider instance.
 *
 * @module pi-crew/channel-provider-factory
 */

import { z } from "zod";
import { ConfigurationError } from "@pi-crew/core";
import type { ChannelProvider, Logger, EventBus } from "@pi-crew/core";
import { DenChannelsAdapter } from "@pi-crew/channels/den-channels/den-channels-adapter";
import type { DenChannelsAdapterConfig } from "@pi-crew/channels/den-channels/den-channels-adapter";
import type { DenConnection } from "@pi-crew/channels/den-channels/connection-types";
import { TelegramChannelProvider } from "@pi-crew/channels/telegram/telegram-channel-provider";
import { TelegramPollingConnection, resolveBotToken } from "@pi-crew/channels/telegram/telegram-connection";
import type { TelegramProviderConfig } from "@pi-crew/channels/telegram/telegram-types";

// ── Config schemas ──────────────────────────────────────────────

const TelegramProviderConfigSchema = z.object({
  providerId: z.literal("telegram"),
  name: z.string().min(1).optional(),
  tokenEnv: z.string().min(1).default("TELEGRAM_BOT_TOKEN"),
  pollingIntervalMs: z.number().int().positive().default(1000),
  allowedChats: z.array(z.string().min(1)).optional(),
  connectionTimeoutMs: z.number().int().positive().default(30_000),
  maxUpdatesPerPoll: z.number().int().positive().default(100),
});

export type TelegramProviderConfigInput = z.infer<typeof TelegramProviderConfigSchema>;

/**
 * Schema for additional channel provider configurations.
 *
 * Each entry defines a provider instance beyond the default Den Channels adapter.
 * The `providerId` field selects the provider type.
 */
export const AdditionalChannelProviderSchema = z.discriminatedUnion("providerId", [
  TelegramProviderConfigSchema,
]);

export type AdditionalChannelProviderConfig = z.infer<typeof AdditionalChannelProviderSchema>;

/**
 * Schema for the top-level `channelProviders` config array.
 */
export const ChannelProvidersConfigSchema = z
  .array(AdditionalChannelProviderSchema)
  .default([]);

// ── Factory ─────────────────────────────────────────────────────

/**
 * Dependencies required by the factory to construct providers.
 */
export interface ChannelProviderFactoryDeps {
  readonly logger: Logger;
  readonly eventBus: EventBus;
}

/**
 * Create a {@link ChannelProvider} from an additional provider config entry.
 *
 * @throws {ConfigurationError} if the provider type is unknown or required
 *   environment variables are missing.
 */
export function createChannelProvider(
  config: AdditionalChannelProviderConfig,
  deps: ChannelProviderFactoryDeps,
): ChannelProvider {
  switch (config.providerId) {
    case "telegram":
      return createTelegramProvider(config, deps);
    default:
      throw new ConfigurationError(
        `Unknown channel provider type: ${(config as { providerId: string }).providerId}`,
      );
  }
}

/**
 * Create all additional channel providers from config.
 */
export function createAdditionalChannelProviders(
  configs: readonly AdditionalChannelProviderConfig[],
  deps: ChannelProviderFactoryDeps,
): ChannelProvider[] {
  return configs.map((config) => createChannelProvider(config, deps));
}

// ── Provider constructors ───────────────────────────────────────

function createTelegramProvider(
  config: TelegramProviderConfigInput,
  deps: ChannelProviderFactoryDeps,
): TelegramChannelProvider {
  const providerConfig: TelegramProviderConfig = {
    tokenEnv: config.tokenEnv,
    pollingIntervalMs: config.pollingIntervalMs,
    allowedChats: config.allowedChats,
    connectionTimeoutMs: config.connectionTimeoutMs,
    maxUpdatesPerPoll: config.maxUpdatesPerPoll,
  };

  // DESIGN: Resolve token at construction time.  Rationale: Fail fast
  // if the env var is missing — don't start a provider that can't authenticate.
  const token = resolveBotToken(providerConfig);

  const connection = new TelegramPollingConnection(token, deps.logger, {
    pollingIntervalMs: config.pollingIntervalMs,
    connectionTimeoutMs: config.connectionTimeoutMs,
    maxUpdatesPerPoll: config.maxUpdatesPerPoll,
  });

  return new TelegramChannelProvider(connection, deps.logger, providerConfig, {
    name: config.name ?? "Telegram Bot",
    providerId: config.providerId,
  });
}

// ── Den Channels adapter factory (for completeness) ─────────────

/**
 * Create the default {@link DenChannelsAdapter}.
 *
 * Kept here so all provider construction flows through one module.
 * The Den adapter requires a pre-built connection (from `buildDenConnection`),
 * so it's not part of the discriminated union — it's always present.
 */
export function createDenChannelsProvider(
  denConnection: DenConnection,
  logger: Logger,
  config?: DenChannelsAdapterConfig,
): DenChannelsAdapter {
  return new DenChannelsAdapter(denConnection, logger, config);
}
