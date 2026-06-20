/**
 * Tests for the channel provider factory.
 *
 * Covers:
 * - Telegram provider creation from config
 * - Unknown provider type → ConfigurationError
 * - Missing token env var → AuthenticationError
 * - Config schema validation
 * - Multiple provider creation
 *
 * @module pi-crew/__tests__/channel-provider-factory
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeLogger, FakeEventBus, ConfigurationError } from "@pi-crew/core";
import { AuthenticationError } from "@pi-crew/core";
import { TelegramChannelProvider } from "@pi-crew/channels/telegram/telegram-channel-provider";
import { SimulatedDenConnection } from "@pi-crew/channels/den-channels/connection-simulated";
import { DenChannelsAdapter } from "@pi-crew/channels/den-channels/den-channels-adapter";
import {
  createChannelProvider,
  createAdditionalChannelProviders,
  createPerAgentDenChannelsProvider,
  AdditionalChannelProviderSchema,
  ChannelProvidersConfigSchema,
} from "../channel-provider-factory.js";
import type {
  AdditionalChannelProviderConfig,
  ChannelProviderFactoryDeps,
} from "../channel-provider-factory.js";

// ── Helpers ─────────────────────────────────────────────────────

function createDeps(): ChannelProviderFactoryDeps {
  return {
    logger: new FakeLogger(),
    eventBus: new FakeEventBus(),
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("channel-provider-factory", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("createChannelProvider", () => {
    it("creates a TelegramChannelProvider when providerId is 'telegram'", () => {
      process.env["TEST_TELEGRAM_TOKEN"] = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

      const config: AdditionalChannelProviderConfig = {
        providerId: "telegram",
        tokenEnv: "TEST_TELEGRAM_TOKEN",
        pollingIntervalMs: 2000,
        connectionTimeoutMs: 15_000,
        maxUpdatesPerPoll: 50,
      };

      const provider = createChannelProvider(config, createDeps());

      expect(provider).toBeInstanceOf(TelegramChannelProvider);
      expect(provider.providerId).toBe("telegram");
      expect(provider.name).toBe("Telegram Bot");
    });

    it("uses custom name when provided", () => {
      process.env["TEST_TELEGRAM_TOKEN"] = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

      const config: AdditionalChannelProviderConfig = {
        providerId: "telegram",
        name: "My Custom Bot",
        tokenEnv: "TEST_TELEGRAM_TOKEN",
        pollingIntervalMs: 1000,
        connectionTimeoutMs: 30_000,
        maxUpdatesPerPoll: 100,
      };

      const provider = createChannelProvider(config, createDeps());

      expect(provider.name).toBe("My Custom Bot");
    });

    it("throws AuthenticationError when token env var is missing", () => {
      delete process.env["MISSING_TOKEN"];

      const config: AdditionalChannelProviderConfig = {
        providerId: "telegram",
        tokenEnv: "MISSING_TOKEN",
        pollingIntervalMs: 1000,
        connectionTimeoutMs: 30_000,
        maxUpdatesPerPoll: 100,
      };

      expect(() => createChannelProvider(config, createDeps())).toThrow(AuthenticationError);
    });

    it("throws ConfigurationError for unknown provider type", () => {
      const config = { providerId: "unknown-provider" } as unknown as AdditionalChannelProviderConfig;

      expect(() => createChannelProvider(config, createDeps())).toThrow(ConfigurationError);
      expect(() => createChannelProvider(config, createDeps())).toThrow(/Unknown channel provider type/);
    });
  });

  describe("createAdditionalChannelProviders", () => {
    it("creates multiple providers from config array", () => {
      process.env["BOT_A_TOKEN"] = "111:AAA";
      process.env["BOT_B_TOKEN"] = "222:BBB";

      const configs: AdditionalChannelProviderConfig[] = [
        {
          providerId: "telegram",
          name: "Bot A",
          tokenEnv: "BOT_A_TOKEN",
          pollingIntervalMs: 1000,
          connectionTimeoutMs: 30_000,
          maxUpdatesPerPoll: 100,
        },
        {
          providerId: "telegram",
          name: "Bot B",
          tokenEnv: "BOT_B_TOKEN",
          pollingIntervalMs: 2000,
          connectionTimeoutMs: 30_000,
          maxUpdatesPerPoll: 100,
        },
      ];

      const providers = createAdditionalChannelProviders(configs, createDeps());

      expect(providers).toHaveLength(2);
      expect(providers[0]!.name).toBe("Bot A");
      expect(providers[1]!.name).toBe("Bot B");
    });

    it("returns empty array when no configs provided", () => {
      const providers = createAdditionalChannelProviders([], createDeps());
      expect(providers).toHaveLength(0);
    });
  });

  describe("AdditionalChannelProviderSchema", () => {
    it("validates a valid telegram config", () => {
      const result = AdditionalChannelProviderSchema.safeParse({
        providerId: "telegram",
        tokenEnv: "TELEGRAM_BOT_TOKEN",
        pollingIntervalMs: 1000,
      });

      expect(result.success).toBe(true);
    });

    it("applies defaults for optional fields", () => {
      const result = AdditionalChannelProviderSchema.safeParse({
        providerId: "telegram",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tokenEnv).toBe("TELEGRAM_BOT_TOKEN");
        expect(result.data.pollingIntervalMs).toBe(1000);
        expect(result.data.connectionTimeoutMs).toBe(30_000);
        expect(result.data.maxUpdatesPerPoll).toBe(100);
      }
    });

    it("rejects invalid providerId", () => {
      const result = AdditionalChannelProviderSchema.safeParse({
        providerId: "slack",
      });

      expect(result.success).toBe(false);
    });

    it("rejects negative pollingIntervalMs", () => {
      const result = AdditionalChannelProviderSchema.safeParse({
        providerId: "telegram",
        pollingIntervalMs: -1,
      });

      expect(result.success).toBe(false);
    });

    it("accepts allowedChats array", () => {
      const result = AdditionalChannelProviderSchema.safeParse({
        providerId: "telegram",
        allowedChats: ["-1001234567890", "12345"],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowedChats).toEqual(["-1001234567890", "12345"]);
      }
    });
  });

  describe("ChannelProvidersConfigSchema", () => {
    it("defaults to empty array", () => {
      const result = ChannelProvidersConfigSchema.safeParse(undefined);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });

    it("validates an array of provider configs", () => {
      const result = ChannelProvidersConfigSchema.safeParse([
        { providerId: "telegram", tokenEnv: "MY_TOKEN" },
      ]);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });
  });

  describe("createPerAgentDenChannelsProvider", () => {
    it("creates a DenChannelsAdapter with agent identity as providerId", () => {
      const connection = new SimulatedDenConnection(new FakeLogger());
      const logger = new FakeLogger();

      const provider = createPerAgentDenChannelsProvider(
        connection,
        logger,
        "prime-coder",
      );

      expect(provider).toBeInstanceOf(DenChannelsAdapter);
      expect(provider.providerId).toBe("prime-coder");
      expect(provider.name).toBe("Agent: prime-coder");
    });

    it("uses the given agent identity for providerId", () => {
      const connection = new SimulatedDenConnection(new FakeLogger());
      const logger = new FakeLogger();

      const provider = createPerAgentDenChannelsProvider(
        connection,
        logger,
        "caretaker",
      );

      expect(provider.providerId).toBe("caretaker");
      expect(provider.name).toBe("Agent: caretaker");
    });
  });
});
