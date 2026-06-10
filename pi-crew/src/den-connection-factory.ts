/**
 * Den Channels connection factory for the pi-crew composition root.
 *
 * Separates transport selection and cursor persistence from `Crew` so the
 * main composition root stays under the file-size limit.
 *
 * @module pi-crew/den-connection-factory
 */

import type { Logger } from "@pi-crew/core";
import { ConfigurationError } from "@pi-crew/core";
import { DenWebSocketConnection } from "@pi-crew/channels/den-channels/connection-websocket";
import { SimulatedDenConnection } from "@pi-crew/channels/den-channels/connection-simulated";
import { DenHttpDirectAgentConnection } from "@pi-crew/channels/den-channels/connection-http";
import type {
  CursorStore,
  DenConnection,
  DenConnectionConfig,
  DenHttpConnectionConfig,
} from "@pi-crew/channels/den-channels/connection-types";
import type { DenConfig, RuntimeDb } from "@pi-crew/service";

/**
 * Build a Den connection from configuration.
 *
 * Protocol detection:
 * - `channelsUrl` starts with `ws://` or `wss://` → WebSocket adapter.
 * - `channelsUrl` starts with `http://` or `https://` → HTTP cursor adapter.
 * - `channelsUrl` is empty → simulated connection for tests/dev.
 *
 * HTTP mode fails closed when project/member identity is missing.
 */
export function buildDenConnection(
  den: DenConfig,
  logger: Logger,
  cursorStore: CursorStore,
  memberIdentities: readonly string[] = [],
): DenConnection {
  if (den.channelsUrl.length === 0) {
    logger.info("No channelsUrl configured — using simulated connection");
    return new SimulatedDenConnection(logger);
  }

  const url = new URL(den.channelsUrl);
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    return buildWebSocketConnection(den, logger);
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return buildHttpConnection(den, logger, cursorStore, memberIdentities);
  }

  throw new ConfigurationError(
    `Unsupported channelsUrl protocol: ${url.protocol}`,
  );
}

/**
 * Create a {@link CursorStore} that persists direct-agent event cursors in
 * the `runtime_kv` table.
 */
export function createSqliteCursorStore(runtimeDb: RuntimeDb): CursorStore {
  const db = runtimeDb.handle;
  const readStmt = db.prepare(
    "SELECT value FROM runtime_kv WHERE key = ?",
  );
  const writeStmt = db.prepare(
    "INSERT OR REPLACE INTO runtime_kv (key, value, updated_at) VALUES (?, ?, ?)",
  );

  return {
    read(key: string): Promise<string | null> {
      const row = readStmt.get(key) as { value: string } | undefined;
      return Promise.resolve(row?.value ?? null);
    },
    write(key: string, value: string): Promise<void> {
      writeStmt.run(key, value, new Date().toISOString());
      return Promise.resolve();
    },
  };
}

function buildWebSocketConnection(
  den: DenConfig,
  logger: Logger,
): DenConnection {
  logger.info("Creating live Den WebSocket connection", {
    url: den.channelsUrl,
    hasToken: den.channelsToken.length > 0,
  });
  const connConfig: DenConnectionConfig = {
    url: den.channelsUrl,
    token: den.channelsToken,
    retryPolicy: {
      maxAttempts: den.channelsRetryMaxAttempts,
      baseDelayMs: den.channelsRetryBaseDelayMs,
      maxDelayMs: den.channelsRetryMaxDelayMs,
    },
    pingIntervalMs: den.channelsPingIntervalMs,
    connectionTimeoutMs: den.channelsConnectionTimeoutMs,
  };
  return new DenWebSocketConnection(connConfig, logger);
}

function buildHttpConnection(
  den: DenConfig,
  logger: Logger,
  cursorStore: CursorStore,
  memberIdentities: readonly string[],
): DenConnection {
  validateHttpConfig(den);
  logger.info("Creating live Den HTTP direct-agent connection", {
    baseUrl: den.channelsUrl,
    projectId: den.channelsProjectId,
    memberIdentity: den.channelsMemberIdentity,
    pollIntervalMs: den.channelsPollIntervalMs,
    pollLimit: den.channelsPollLimit,
    subscriptionChannelId: den.channelsSubscriptionChannelId,
    legacyDirectPolling: den.channelsAllowLegacyDirectPolling,
  });

  const httpConfig = {
    baseUrl: den.channelsUrl,
    projectId: den.channelsProjectId,
    memberIdentity: den.channelsMemberIdentity,
    memberIdentities,
    token: den.channelsToken,
    pollIntervalMs: den.channelsPollIntervalMs,
    pollLimit: den.channelsPollLimit,
    subscription: den.channelsAllowLegacyDirectPolling
      ? undefined
      : {
          channelId: den.channelsSubscriptionChannelId,
          profileIdentity: den.channelsProfileIdentity,
          memberRole: den.channelsMemberRole.length === 0 ? undefined : den.channelsMemberRole,
          agentInstanceId: den.channelsAgentInstanceId,
          sessionOwnerId: den.channelsSessionOwnerId,
          sessionId: den.channelsSessionId,
          subscriptionIdentity: den.channelsSubscriptionIdentity,
        },
    allowLegacyDirectPolling: den.channelsAllowLegacyDirectPolling,
  } satisfies DenHttpConnectionConfig & { readonly memberIdentities: readonly string[] };
  return new DenHttpDirectAgentConnection(httpConfig, logger, cursorStore);
}

function validateHttpConfig(den: DenConfig): void {
  if (den.channelsProjectId.length === 0) {
    throw new ConfigurationError(
      "den.channelsProjectId is required when channelsUrl uses http:// or https://",
    );
  }
  if (den.channelsMemberIdentity.length === 0) {
    throw new ConfigurationError(
      "den.channelsMemberIdentity is required when channelsUrl uses http:// or https://",
    );
  }
  if (den.channelsAllowLegacyDirectPolling) return;
  const requiredFields: ReadonlyArray<readonly [string, string]> = [
    ["channelsSubscriptionChannelId", den.channelsSubscriptionChannelId],
    ["channelsProfileIdentity", den.channelsProfileIdentity],
    ["channelsAgentInstanceId", den.channelsAgentInstanceId],
    ["channelsSessionOwnerId", den.channelsSessionOwnerId],
    ["channelsSessionId", den.channelsSessionId],
    ["channelsSubscriptionIdentity", den.channelsSubscriptionIdentity],
  ];
  const missing = requiredFields.find((entry) => entry[1].length === 0)?.[0];
  if (missing !== undefined) {
    throw new ConfigurationError(
      `den.${missing} is required for HTTP Channels v8 subscription registration`,
    );
  }
}
