/**
 * Den Channel assembly builder — Den connection, providers, channel router,
 * and all provider onMessage wiring.
 *
 * Fourth in the dependency chain: requires infra, persistence, and mcp assemblies.
 *
 * @module pi-crew/den-channel-assembly
 */

import type { Logger, ChannelProvider, EventBus } from "@pi-crew/core";
import { DenChannelsAdapter } from "@pi-crew/channels/den-channels/den-channels-adapter";
import type { DenChannelsAdapterConfig } from "@pi-crew/channels/den-channels/den-channels-adapter";
import type { DenConnection } from "@pi-crew/channels/den-channels/connection-types";
import { buildDenConnection, buildAgentDenConnection } from "./den-connection-factory.js";
import {
  createDenChannelsProvider,
  createPerAgentDenChannelsProvider,
  createAdditionalChannelProviders,
  type ChannelProviderFactoryDeps,
} from "./channel-provider-factory.js";
import { ChannelRouter } from "./channel-router.js";
import { ChannelRegistry } from "./channel-registry.js";
import {
  resolveAgentFields,
  type ResolvedAgentFields,
} from "./full-agent-sessions.js";
import type { InfraAssembly } from "./infra-assembly.js";
import type { PersistenceAssembly } from "./persistence-assembly.js";
import type { McpAssembly } from "./mcp-assembly.js";
import { resolveCrewInstallLayout } from "./config.js";

export interface DenChannelAssembly {
  /** Primary Den Channels provider (crew identity). */
  readonly channelProvider: ChannelProvider;
  /** Per-agent providers, keyed by member identity. */
  readonly perAgentProviders: ReadonlyMap<string, ChannelProvider>;
  /** Additional providers (Telegram, etc.). */
  readonly additionalProviders: ChannelProvider[];
  /** Channel router for authorization and mention matching. */
  readonly channelRouter: ChannelRouter;
  /** Unified provider lifecycle registry. */
  readonly channelRegistry: ChannelRegistry;
  /** The raw Den connection for the primary provider (needed for BreadcrumbManager lifecycle). */
  readonly denConnection: DenConnection;
}

export interface DenChannelAssemblyDeps {
  readonly infra: InfraAssembly;
  readonly persistence: PersistenceAssembly;
  readonly mcp: McpAssembly;
}

export function setupDenChannels(deps: DenChannelAssemblyDeps): DenChannelAssembly {
  const { infra, persistence, mcp } = deps;
  const { config, logger, eventBus } = infra;
  const { cursorStore } = persistence;
  const profilesRoot = resolveCrewInstallLayout(config).profilesRoot;

  // Resolve agent fields first so we can pass agent member identities
  // to the primary Den connection for event routing.
  const resolvedAgents = config.fullAgents
    .filter((a) => a.enabled)
    .map((a) => resolveAgentFields(a, profilesRoot));

  // ── Primary Den connection and provider ──────────────────────
  const denConnection = buildDenConnection(
    config.den,
    logger,
    cursorStore,
    resolvedAgents.map((a) => a.memberIdentity),
  );
  const channelProvider = createDenChannelsProvider(denConnection, logger, {
    name: "Den Channels Gateway",
  } satisfies DenChannelsAdapterConfig);

  // ── Per-agent Den Channels providers ─────────────────────────
  const perAgentProviders = new Map<string, ChannelProvider>();
  for (const fields of resolvedAgents) {
    const agentConnection = buildAgentDenConnection(
      config.den,
      fields,
      cursorStore,
      logger,
    );
    const agentProvider = createPerAgentDenChannelsProvider(
      agentConnection,
      logger,
      fields.memberIdentity,
    );
    perAgentProviders.set(fields.memberIdentity, agentProvider);
  }

  // ── ChannelRouter ───────────────────────────────────────────
  const routerBindings = resolvedAgents.map((fields) => ({
    memberIdentity: fields.memberIdentity,
    channelIds: fields.channels.map((c) => c.channelId),
  }));
  const channelRouter = new ChannelRouter(
    { agentBindings: routerBindings },
    logger,
  );

  // ── Additional channel providers (e.g. Telegram) ────────────
  const additionalProviders = createAdditionalChannelProviders(
    config.channelProviders,
    { logger, eventBus },
  );

  // ── ChannelRegistry ─────────────────────────────────────────
  const channelRegistry = new ChannelRegistry({
    channelProvider,
    perAgentProviders,
    additionalProviders,
  });

  return {
    channelProvider,
    perAgentProviders,
    additionalProviders,
    channelRouter,
    channelRegistry,
    denConnection,
  };
}
