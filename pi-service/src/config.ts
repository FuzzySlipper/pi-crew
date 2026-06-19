/**
 * Gateway configuration loading and validation using zod.
 *
 * The gateway MUST crash on invalid config — there is no degraded-start
 * path.  Every field is validated at startup; each failure produces a
 * descriptive ConfigurationError for each failure.
 *
 * @module pi-service/config
 */

import { z } from "zod";
import { ConfigurationError } from "@pi-crew/core";
import { isLoopbackHost } from "./admin/admin-server.js";

// ── Zod schemas ─────────────────────────────────────────────────

const DatabaseConfigSchema = z.object({
  /** Absolute path to the SQLite runtime database. */
  path: z.string().min(1, "database.path must not be empty").default("/var/lib/pi-crew/runtime.db"),
  /** Enable WAL mode for read concurrency. */
  wal: z.boolean().default(true),
  /** SQLite busy timeout in milliseconds. */
  busyTimeoutMs: z.number().int().positive().default(5000),
});

const ChannelsUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (value.length === 0) return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === "ws:" ||
        url.protocol === "wss:" ||
        url.protocol === "http:" ||
        url.protocol === "https:"
      );
    } catch {
      return false;
    }
  }, "den.channelsUrl must be empty or a valid ws://, wss://, http://, or https:// URL")
  .default("");

const DenConfigSchema = z.object({
  /** REST API base URL for Den Core (e.g. "http://den-srv:3030"). */
  coreUrl: z.string().url("den.coreUrl must be a valid URL").default("http://den-srv:3030"),
  /** Timeout in milliseconds for the Den startup reachability check. */
  startupCheckTimeoutMs: z.number().int().positive().default(5_000),
  /**
   * Den Channels Gateway WebSocket URL for live channel participation
   * (e.g. "ws://den-k8plus:4201"). An empty or missing value disables
   * the live WebSocket connection; the gateway falls back to a simulated
   * connection suitable for tests and offline development.
   *
   * **Conversation API only.** This URL is used for channel messages,
   * memberships, subscriptions, cursors, and direct-agent event polling.
   * It must NOT be used as the implicit delivery/gateway/runtime URL.
   */
  channelsUrl: ChannelsUrlSchema,
  /**
   * Den Gateway base URL for executable actuation (delivery intent/claim,
   * adapter binding heartbeat, direct-agent event posting for actuator
   * wake). When absent, defaults to the channelsUrl value as a temporary
   * compatibility fallback — this fallback is deprecated and will be
   * removed in a future phase.
   */
  gatewayUrl: z.string().url().optional(),
  /**
   * Den Delivery base URL for delivery intent/claim/terminalization
   * lifecycle. When absent, defaults to the gatewayUrl value (or
   * channelsUrl if gatewayUrl is also absent) as a temporary compatibility
   * fallback.
   */
  deliveryUrl: z.string().url().optional(),
  /**
   * Auth token for the Den Channels Gateway. Do NOT commit real tokens —
   * provide them from the service environment or user-scoped config.
   */
  channelsToken: z.string().default(""),
  /** Maximum live Channels reconnect attempts. */
  channelsRetryMaxAttempts: z.number().int().positive().default(5),
  /** Initial live Channels reconnect backoff delay in milliseconds. */
  channelsRetryBaseDelayMs: z.number().int().positive().default(200),
  /** Maximum live Channels reconnect backoff delay in milliseconds. */
  channelsRetryMaxDelayMs: z.number().int().positive().default(30_000),
  /** Live Channels heartbeat/ping interval in milliseconds. */
  channelsPingIntervalMs: z.number().int().positive().default(30_000),
  /** Live Channels connection timeout in milliseconds. */
  channelsConnectionTimeoutMs: z.number().int().positive().default(10_000),
  /**
   * Den Channels project ID for HTTP direct-agent-events polling.
   * Required when channelsUrl uses http:// or https:// protocol.
   * Used to scope GET /api/direct-agent-events?projectId=<id>.
   */
  channelsProjectId: z.string().default(""),
  /**
   * Den Channels member identity for HTTP direct-agent-events polling.
   * Required when channelsUrl uses http:// or https:// protocol.
   * Must match an active Channels member identity for event delivery.
   */
  channelsMemberIdentity: z.string().default(""),
  /**
   * Polling interval in milliseconds for HTTP cursor-based
   * direct-agent-events consumption. Default 5000 (5 seconds).
   */
  channelsPollIntervalMs: z.number().int().positive().default(5_000),
  /**
   * Maximum events to fetch per poll when consuming
   * GET /api/direct-agent-events. Default 10.
   */
  channelsPollLimit: z.number().int().positive().default(10),
  /** Ordinary Den Channels channel id used for v8 membership/subscription registration. */
  channelsSubscriptionChannelId: z.string().default(""),
  /** Stable profile identity for the public Den Channels agent membership. */
  channelsProfileIdentity: z.string().default(""),
  /** Optional member role included in Den Channels membership metadata. */
  channelsMemberRole: z.string().default(""),
  /** Concrete runtime instance id used for the active ordinary-channel subscription. */
  channelsAgentInstanceId: z.string().default(""),
  /** Durable full-agent session owner id bound to the active subscription. */
  channelsSessionOwnerId: z.string().default(""),
  /** Durable full-agent session id bound to the active subscription. */
  channelsSessionId: z.string().default(""),
  /** Deterministic subscription identity for the active ordinary-channel subscription. */
  channelsSubscriptionIdentity: z.string().default(""),
  /** Whether to refuse startup if Den is unreachable. */
  requiredAtStartup: z.boolean().default(true),
});

const HealthConfigSchema = z.object({
  /** Port the health-check HTTP server listens on. */
  port: z.number().int().min(1).max(65535).default(9236),
  /** Host/IP to bind the health server to. */
  host: z.string().min(1).default("127.0.0.1"),
});

const AdminConfigSchema = z
  .object({
    /** Enables the local read-only admin diagnostics HTTP surface. */
    enabled: z.boolean().default(false),
    /** Admin server bind host. Defaults to loopback for LAN safety. */
    host: z.string().min(1).default("127.0.0.1"),
    /** Admin server port. */
    port: z.number().int().min(1).max(65535).default(9237),
    /** Bearer token required for /admin/* routes. Use null only for explicit LAN diagnostics. */
    bearerToken: z.string().nullable().default(""),
    /** Explicit opt-in for non-loopback admin bind hosts. */
    allowLanBind: z.boolean().default(false),
  })
  .default({})
  .superRefine((value, context) => {
    if (value.enabled && value.bearerToken === "") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bearerToken"],
        message: "admin.bearerToken is required when admin.enabled is true",
      });
    }
    if (value.enabled && !value.allowLanBind && !isLoopbackHost(value.host)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowLanBind"],
        message: "admin.allowLanBind must be true for non-loopback admin.host",
      });
    }
  });

const LoggingConfigSchema = z.object({
  /** Minimum log level: "debug" | "info" | "warn" | "error". */
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** If true, output JSON to stdout instead of human-readable. */
  json: z.boolean().default(false),
});

const RuntimeResponseModeSchema = z.enum(["echo", "deterministicTool"]);

const DeterministicToolConfigSchema = z.object({
  /**
   * Enables the built-in deterministic arithmetic tool for the narrow
   * #2020 live smoke path. This is intentionally explicit so selecting
   * deterministic mode cannot silently fall back to echo at startup.
   */
  arithmeticToolEnabled: z.boolean().default(false),
});

const RuntimeConfigSchema = z
  .object({
    /** Runtime response strategy for AgentInstance responders. */
    responseMode: RuntimeResponseModeSchema.default("echo"),
    /** Required settings for deterministic tool-backed smoke mode. */
    deterministicTool: DeterministicToolConfigSchema.default({}),
    /** Stream retry configuration for model calls. */
    streamRetry: z
      .object({
        enabled: z.boolean().default(true),
        maxAttempts: z.number().int().positive().default(3),
        baseDelayMs: z.number().int().nonnegative().default(500),
        maxDelayMs: z.number().int().nonnegative().default(5_000),
        jitterRatio: z.number().min(0).max(1).default(0.2),
        retryableHttpStatuses: z.array(z.number().int()).default([408, 429, 502, 503, 504]),
      })
      .default({}),
    /** Default model metadata for LLM-backed delegated children. */
    modelDefaults: z
      .object({
        fallbackModelId: z.string().default("delegated-child"),
        contextWindow: z.number().int().positive().default(131_072),
        maxTokens: z.number().int().positive().default(2048),
        thinkingFormat: z
          .enum(["ant-ling", "openai", "deepseek", "openrouter", "zai", "together", "qwen", "qwen-chat-template", "string-thinking"])
          .default("qwen"),
      })
      .default({}),
  })
  .default({})
  .superRefine((value, context) => {
    if (
      value.responseMode === "deterministicTool" &&
      !value.deterministicTool.arithmeticToolEnabled
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deterministicTool", "arithmeticToolEnabled"],
        message:
          "runtime.deterministicTool.arithmeticToolEnabled must be true when runtime.responseMode is deterministicTool",
      });
    }
  });

/** Session-level configuration. */
const SessionsConfigSchema = z
  .object({
    /** Conversational full-agent turn timeout in milliseconds. */
    conversationalTurnTimeoutMs: z.number().int().positive().default(300_000),
    /** Maximum instances allowed per profile. */
    maxPerProfile: z.number().int().positive().default(4),
    /** Maximum total instances across all profiles. */
    maxTotal: z.number().int().positive().default(16),
    /** Idle timeout in milliseconds before an instance is eligible for eviction. */
    idleTimeoutMs: z.number().int().positive().default(8 * 60 * 60 * 1000),
  })
  .default({});

/** Worker-level configuration. */
const WorkersConfigSchema = z
  .object({
    /** Default assignment duration timeout in milliseconds (30 minutes). */
    defaultAssignmentTimeoutMs: z.number().int().positive().default(30 * 60 * 1000),
    /** Default per-turn timeout in milliseconds (5 minutes). */
    defaultTurnTimeoutMs: z.number().int().positive().default(5 * 60 * 1000),
    /** Limits for delegated helper tools. */
    helperLimits: z
      .object({
        /** Maximum safe excerpt characters for truncation. */
        maxSafeExcerptChars: z.number().int().positive().default(1_600),
      })
      .default({}),
  })
  .default({});

/** Agent-work lifecycle publishing configuration. */
const AgentWorkConfigSchema = z
  .object({
    /** Timeout in milliseconds for lifecycle event HTTP publishes. */
    lifecyclePublishTimeoutMs: z.number().int().positive().default(5_000),
    /** URL path for lifecycle event publishing. */
    lifecyclePath: z.string().default("/api/agent-work/lifecycle-events"),
  })
  .default({});

/** Diagnostics configuration. */
const DiagnosticsConfigSchema = z
  .object({
    /** Maximum number of recent events to include in diagnostics projection. */
    maxRecentEvents: z.number().int().positive().default(50),
    /** Fallback version label when none is provided. */
    versionFallback: z.string().default("development"),
  })
  .default({});

export const GatewayConfigSchema = z.object({
  admin: AdminConfigSchema,
  database: DatabaseConfigSchema.default({}),
  den: DenConfigSchema,
  health: HealthConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  runtime: RuntimeConfigSchema,
  sessions: SessionsConfigSchema,
  workers: WorkersConfigSchema,
  agentWork: AgentWorkConfigSchema,
  diagnostics: DiagnosticsConfigSchema,
});

// ── Inferred types ──────────────────────────────────────────────

/** Full strongly-typed gateway configuration. */
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/** Database sub-config. */
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

/** Den connectivity sub-config. */
export type DenConfig = z.infer<typeof DenConfigSchema>;

/** Health-check sub-config. */
export type HealthConfig = z.infer<typeof HealthConfigSchema>;

/** Local admin diagnostics sub-config. */
export type AdminConfig = z.infer<typeof AdminConfigSchema>;

/** Logging sub-config. */
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

/** Runtime responder/provider sub-config. */
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/** Sessions sub-config. */
export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;

/** Workers sub-config. */
export type WorkersConfig = z.infer<typeof WorkersConfigSchema>;

/** Agent-work lifecycle publishing sub-config. */
export type AgentWorkConfig = z.infer<typeof AgentWorkConfigSchema>;

/** Diagnostics sub-config. */
export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;

// ── Loader ──────────────────────────────────────────────────────

/**
 * Parse and validate raw configuration data.
 *
 * Returns the validated config or throws {@link ConfigurationError}
 * with a multi-line message listing every validation failure.
 *
 * @param raw — Untrusted config object (e.g. from JSON or env).
 * @returns Parsed and validated {@link GatewayConfig}.
 */
export function loadConfig(raw: unknown): GatewayConfig {
  const result = GatewayConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigurationError(`Invalid gateway configuration:\n${issues}`);
  }

  return result.data;
}
